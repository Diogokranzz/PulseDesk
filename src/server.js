import { createReadStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CoinbaseFeed } from "./coinbase-feed.js";
import { KrakenFeed } from "./kraken-feed.js";
import { Journal } from "./journal.js";
import { MarketCache } from "./market-cache.js";
import { MarketEngine } from "./market.js";
import { PerformanceStore } from "./performance-store.js";
import { TradingEngine } from "./trading.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const browserPath = resolve(root, "dist/pulsedesk/browser");
const dataPath = resolve(root, process.env.PULSEDESK_DATA_DIR ?? "data");
const journal = new Journal(resolve(dataPath, "ledger.jsonl"));
const market = new MarketEngine({ intelligenceEnabled: process.env.PULSEDESK_AI !== "0" });
const marketCache = new MarketCache(resolve(dataPath, "market-cache.json"), market);
const performanceStore = new PerformanceStore(resolve(dataPath, "equity-history.json"), market);
const feed = new CoinbaseFeed(market);
const krakenFeed = new KrakenFeed(market);
const events = await journal.open();
const trading = new TradingEngine(journal, market);
trading.restore(events);
await mkdir(dataPath, { recursive: true });
await marketCache.restore();
await performanceStore.restore();

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".ico", "image/x-icon"],
  [".woff2", "font/woff2"]
]);
const streams = new Set();
const requests = new Map();
let shuttingDown = false;
let sequence = 0;

function securityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
}

function json(response, status, data) {
  const body = JSON.stringify(data);
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(body) });
  response.end(body);
}

function applyRateLimit(request, response) {
  const key = request.socket.remoteAddress ?? "unknown";
  const now = Date.now();
  const state = requests.get(key) ?? { startedAt: now, count: 0 };
  if (now - state.startedAt > 60000) {
    state.startedAt = now;
    state.count = 0;
  }
  state.count += 1;
  requests.set(key, state);
  if (state.count <= 180) return true;
  response.setHeader("Retry-After", "60");
  json(response, 429, { error: "Muitas solicitações. Aguarde um minuto." });
  return false;
}

async function readJson(request, maximumBytes = 16384) {
  const declaredSize = Number(request.headers["content-length"] ?? 0);
  if (declaredSize > maximumBytes) throw new Error("Corpo da solicitação excede o limite");
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > maximumBytes) throw new Error("Corpo da solicitação excede o limite");
  }
  try {
    return JSON.parse(body || "{}");
  } catch {
    throw new Error("JSON inválido");
  }
}

function snapshot(symbol) {
  return { ...market.getSnapshot(symbol, trading), operations: { sseConnections: streams.size, uptimeSeconds: Math.floor(process.uptime()) } };
}

function sendStreamEvent(stream, data) {
  if (stream.response.destroyed) {
    streams.delete(stream);
    return;
  }
  if (stream.blocked) {
    stream.pending = data;
    return;
  }
  const payload = JSON.stringify(data).replaceAll("\n", "");
  const ready = stream.response.write(`id: ${++sequence}\nevent: snapshot\ndata: ${payload}\n\n`);
  if (!ready) {
    stream.blocked = true;
    stream.response.once("drain", () => {
      stream.blocked = false;
      const pending = stream.pending;
      stream.pending = null;
      if (pending) sendStreamEvent(stream, pending);
    });
  }
}

function serveStatic(requestPath, request, response) {
  let pathname;
  try {
    pathname = decodeURIComponent(requestPath);
  } catch {
    json(response, 400, { error: "Caminho inválido" });
    return;
  }
  if (pathname === "/") pathname = "/index.html";
  const target = resolve(browserPath, `.${pathname}`);
  if (!target.startsWith(`${browserPath}${sep}`)) {
    json(response, 404, { error: "Recurso não encontrado" });
    return;
  }
  const navigationFallback = request.headers.accept?.includes("text/html") && !extname(pathname);
  const sendFile = (file) => stat(file).then((info) => {
    if (!info.isFile()) {
      json(response, 404, { error: "Recurso não encontrado" });
      return;
    }
    response.writeHead(200, {
      "Content-Type": mimeTypes.get(extname(file)) ?? "application/octet-stream",
      "Cache-Control": [".html", ".css", ".js"].includes(extname(file)) ? "no-store" : "public, max-age=300"
    });
    const fileStream = createReadStream(file);
    fileStream.on("error", (error) => {
      if (!response.headersSent) json(response, 404, { error: "Recurso não encontrado" });
      else response.destroy(error);
    });
    fileStream.pipe(response);
  });
  sendFile(target).catch(() => {
    if (navigationFallback) sendFile(resolve(browserPath, "index.html")).catch(() => json(response, 404, { error: "Recurso não encontrado" }));
    else json(response, 404, { error: "Recurso não encontrado" });
  });
}

const server = createServer(async (request, response) => {
  securityHeaders(response);
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const pathname = url.pathname;
  if (pathname.startsWith("/api/") && pathname !== "/api/stream" && !applyRateLimit(request, response)) return;

  try {
    if (request.method === "GET" && pathname === "/api/health/live") {
      json(response, 200, { status: "ok", time: Date.now() });
      return;
    }

    if (request.method === "GET" && pathname === "/api/health/ready") {
      const marketHealth = market.getSnapshot("BTCUSD", trading).feed;
      json(response, 200, { status: "ready", mode: "paper", degraded: marketHealth.status !== "online" || !marketHealth.quoteFresh, time: Date.now() });
      return;
    }

    if (request.method === "GET" && pathname === "/api/health") {
      const marketHealth = market.getSnapshot("BTCUSD", trading).feed;
      json(response, 200, { status: "ok", mode: "paper", degraded: marketHealth.status !== "online" || !marketHealth.quoteFresh, market: marketHealth, time: Date.now(), streams: streams.size });
      return;
    }

    if (request.method === "GET" && pathname === "/api/snapshot") {
      const symbol = (url.searchParams.get("symbol") ?? "BTCUSD").toUpperCase();
      if (!market.hasSymbol(symbol)) {
        json(response, 400, { error: "Ativo inválido" });
        return;
      }
      json(response, 200, snapshot(symbol));
      return;
    }

    if (request.method === "GET" && pathname === "/api/orders") {
      json(response, 200, { orders: trading.orders });
      return;
    }

    if (request.method === "GET" && pathname === "/api/ledger") {
      json(response, 200, { fills: trading.fills, positions: trading.positions, cash: trading.cash, realizedPnl: trading.realizedPnl, capitalConfigured: trading.capitalConfigured });
      return;
    }

    if (request.method === "GET" && pathname === "/api/account/backup") {
      try {
        json(response, 200, await trading.exportBackup());
      } catch {
        json(response, 422, { error: "Não foi possível exportar a simulação" });
      }
      return;
    }

    if (request.method === "GET" && pathname === "/api/stream") {
      if (streams.size >= 60) {
        json(response, 503, { error: "Limite de conexões em tempo real atingido" });
        return;
      }
      const symbol = (url.searchParams.get("symbol") ?? "BTCUSD").toUpperCase();
      if (!market.hasSymbol(symbol)) {
        json(response, 400, { error: "Ativo inválido" });
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      response.write("retry: 2500\n\n");
      const stream = { response, symbol, blocked: false, pending: null };
      streams.add(stream);
      sendStreamEvent(stream, snapshot(symbol));
      response.on("close", () => streams.delete(stream));
      return;
    }

    if (request.method === "POST" && pathname === "/api/orders") {
      let input;
      try {
        input = await readJson(request);
      } catch (error) {
        const status = error.message.includes("excede o limite") ? 413 : 400;
        json(response, status, { error: error.message });
        return;
      }
      try {
        const result = await trading.submit(input);
        json(response, result.duplicate ? 200 : 201, { ...result, account: snapshot(result.order.symbol).account });
      } catch (error) {
        json(response, 422, { error: error.message });
      }
      return;
    }

    if (request.method === "POST" && pathname === "/api/account/capital") {
      let input;
      try {
        input = await readJson(request);
      } catch (error) {
        const status = error.message.includes("excede o limite") ? 413 : 400;
        json(response, status, { error: error.message });
        return;
      }
      try {
        await trading.configureCapital(input);
        market.clearAccountPerformance();
        await performanceStore.clear();
        json(response, 200, { account: snapshot("BTCUSD").account });
      } catch (error) {
        json(response, 422, { error: error.message });
      }
      return;
    }

    if (request.method === "POST" && pathname === "/api/account/backup") {
      const origin = request.headers.origin;
      if (origin && origin !== url.origin) {
        json(response, 403, { error: "Origem da solicitaÃ§Ã£o invÃ¡lida" });
        return;
      }
      if (request.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") {
        json(response, 415, { error: "O backup deve ser enviado como JSON" });
        return;
      }
      let input;
      try {
        input = await readJson(request, 4 * 1024 * 1024);
      } catch (error) {
        const status = error.message.includes("excede o limite") ? 413 : 400;
        json(response, status, { error: error.message });
        return;
      }
      try {
        await trading.importBackup(input);
        market.clearAccountPerformance();
        await performanceStore.clear();
        json(response, 200, { snapshot: snapshot("BTCUSD") });
      } catch (error) {
        json(response, 422, { error: error.message || "Simulação inválida" });
      }
      return;
    }

    if (request.method === "POST" && pathname === "/api/account/reset") {
      const symbol = (url.searchParams.get("symbol") ?? "BTCUSD").toUpperCase();
      if (!market.hasSymbol(symbol)) {
        json(response, 400, { error: "Ativo inválido" });
        return;
      }
      try {
        await trading.reset();
        market.clearAccountPerformance();
        await performanceStore.clear();
        json(response, 200, { snapshot: snapshot(symbol) });
      } catch {
        json(response, 500, { error: "Não foi possível apagar os dados da simulação" });
      }
      return;
    }

    const cancelMatch = pathname.match(/^\/api\/orders\/([a-f0-9-]+)$/i);
    if (request.method === "DELETE" && cancelMatch) {
      try {
        const order = await trading.cancel(cancelMatch[1]);
        json(response, 200, { order });
      } catch (error) {
        json(response, 422, { error: error.message });
      }
      return;
    }

    if (request.method === "GET" && pathname.startsWith("/api/")) {
      json(response, 404, { error: "Rota da API não encontrada" });
      return;
    }

    if (request.method === "GET") {
      serveStatic(pathname, request, response);
      return;
    }

    json(response, 405, { error: "Método não permitido" });
  } catch (error) {
    if (!response.headersSent) json(response, 500, { error: "Não foi possível processar a solicitação" });
    else response.destroy(error);
  }
});

server.requestTimeout = 10000;
server.headersTimeout = 12000;
server.keepAliveTimeout = 5000;

let snapshotUpdateRunning = false;
const snapshotPublisher = setInterval(async () => {
  if (shuttingDown || snapshotUpdateRunning) return;
  snapshotUpdateRunning = true;
  try {
    await trading.matchLimitOrders();
    for (const stream of streams) sendStreamEvent(stream, snapshot(stream.symbol));
  } catch (error) {
    process.stderr.write(`${new Date().toISOString()} market update failed: ${error.message}\n`);
  } finally {
    snapshotUpdateRunning = false;
  }
}, 900);

const marketCacheWriter = setInterval(() => {
  if (!shuttingDown) void marketCache.persistIfChanged();
}, 1500);

const performanceWriter = setInterval(() => {
  if (!shuttingDown) void performanceStore.persistIfChanged();
}, 5000);

const heartbeat = setInterval(() => {
  for (const stream of streams) {
    if (!stream.response.destroyed && !stream.blocked) stream.response.write(`: keepalive ${Date.now()}\n\n`);
    else streams.delete(stream);
  }
}, 15000);

const port = Number(process.env.PORT ?? 4173);
const host = process.env.HOST ?? "127.0.0.1";
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT deve ser um número entre 1 e 65535");
server.on("error", async (error) => {
  clearInterval(snapshotPublisher);
  clearInterval(heartbeat);
  clearInterval(marketCacheWriter);
  clearInterval(performanceWriter);
  feed.stop();
  krakenFeed.stop();

  if (error.code === "EADDRINUSE") {
    let pulseDeskAlreadyRunning = false;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
      const health = await response.json();
      pulseDeskAlreadyRunning = response.ok && health.status === "ok" && health.mode === "paper";
    } catch {
      pulseDeskAlreadyRunning = false;
    }

    await journal.drain();
    await marketCache.flush();
    await performanceStore.flush();
    if (pulseDeskAlreadyRunning) {
      process.stdout.write(`Pulse Desk já está ativo em http://localhost:${port}; nenhuma segunda instância foi iniciada.\n`);
      process.exit(0);
    }

    process.stderr.write(`A porta ${port} já está ocupada por outro processo.\n`);
    process.exit(1);
  }

  await journal.drain();
  await marketCache.flush();
  await performanceStore.flush();
  process.stderr.write(`Não foi possível iniciar o Pulse Desk: ${error.message}\n`);
  process.exit(1);
});

server.listen(port, host, () => {
  feed.start();
  krakenFeed.start();
  process.stdout.write(`Pulse Desk ativo em http://localhost:${port}\n`);
});

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(snapshotPublisher);
  clearInterval(heartbeat);
  clearInterval(marketCacheWriter);
  clearInterval(performanceWriter);
  feed.stop();
  krakenFeed.stop();
  for (const stream of streams) stream.response.end();
  streams.clear();
  server.close(async () => {
    await journal.drain();
    await marketCache.flush();
    await performanceStore.flush();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
