const endpoint = "wss://advanced-trade-ws.coinbase.com";
const restEndpoint = "https://api.coinbase.com/api/v3/brokerage/market/products";
const channels = ["ticker", "level2", "market_trades"];

export class CoinbaseFeed {
  #market;
  #socket = null;
  #retryTimer = null;
  #stableTimer = null;
  #fallbackTimer = null;
  #retryDelay = 1000;
  #fallbackDelay = 2500;
  #fallbackBusy = false;
  #lastFallbackAt = 0;
  #stopped = false;

  constructor(market) {
    this.#market = market;
  }

  start() {
    this.#stopped = false;
    this.#market.setConnection("connecting");
    const cutoffAt = Math.floor(Date.now() / 1000) * 1000;
    this.#market.setHistoryCutoff(cutoffAt);
    this.#loadHistory(cutoffAt);
    this.#connect();
    this.#scheduleFallback(1500);
  }

  stop() {
    this.#stopped = true;
    clearTimeout(this.#retryTimer);
    clearTimeout(this.#stableTimer);
    clearTimeout(this.#fallbackTimer);
    this.#market.setConnection("offline");
    this.#socket?.close();
    this.#socket = null;
  }

  async #loadHistory(cutoffAt) {
    const end = Math.floor(cutoffAt / 1000);
    const start = end - 350 * 60;
    await Promise.allSettled(this.#market.productIds.map(async (productId) => {
      const query = new URLSearchParams({ start: String(start), end: String(end), granularity: "ONE_MINUTE", limit: "350" });
      const response = await fetch(`${restEndpoint}/${encodeURIComponent(productId)}/candles?${query}`, { signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error(`Histórico ${productId} respondeu ${response.status}`);
      const payload = await response.json();
      const symbol = `${productId.replace("-", "")}`;
      this.#market.loadCandles(symbol, payload.candles ?? [], cutoffAt);
    })).then((results) => {
      for (const result of results) {
        if (result.status === "rejected") process.stderr.write(`${new Date().toISOString()} Coinbase candle history unavailable: ${result.reason.message}\n`);
      }
    });
  }

  #scheduleFallback(delay = this.#fallbackDelay) {
    if (this.#stopped || this.#fallbackTimer) return;
    this.#fallbackTimer = setTimeout(async () => {
      this.#fallbackTimer = null;
      if (this.#stopped) return;
      if (this.#market.needsRestFallback && !this.#fallbackBusy && Date.now() - this.#lastFallbackAt >= this.#fallbackDelay - 500) {
        this.#fallbackBusy = true;
        this.#lastFallbackAt = Date.now();
        try {
          const results = await Promise.allSettled(this.#market.productIds.map(async (productId) => {
            const response = await fetch(`${restEndpoint}/${encodeURIComponent(productId)}`, { signal: AbortSignal.timeout(5000) });
            if (!response.ok) throw new Error(`${productId}: HTTP ${response.status}`);
            return response.json();
          }));
          let restored = 0;
          const failures = [];
          for (const result of results) {
            if (result.status === "fulfilled") {
              if (this.#market.ingestRestProduct(result.value?.product ?? result.value)) restored += 1;
            } else {
              failures.push(result.reason?.message ?? "network failure");
            }
          }
          if (restored) {
            this.#fallbackDelay = 3000;
          } else {
            this.#fallbackDelay = Math.min(Math.max(this.#fallbackDelay * 2, 5000), 30000);
            if (failures.length) process.stderr.write(`${new Date().toISOString()} Coinbase REST fallback unavailable: ${failures.slice(0, 2).join("; ")}\n`);
          }
        } catch (error) {
          this.#fallbackDelay = Math.min(Math.max(this.#fallbackDelay * 2, 5000), 30000);
          process.stderr.write(`${new Date().toISOString()} Coinbase REST fallback failed: ${error.message}\n`);
        } finally {
          this.#fallbackBusy = false;
        }
      }
      this.#scheduleFallback();
    }, delay);
  }

  #connect() {
    if (this.#stopped) return;
    this.#market.setConnection("connecting");
    let socket;
    try {
      socket = new WebSocket(endpoint);
    } catch (error) {
      process.stderr.write(`${new Date().toISOString()} Coinbase connection failed: ${error.message}\n`);
      this.#scheduleReconnect();
      return;
    }
    this.#socket = socket;
    socket.addEventListener("open", () => {
      if (this.#stopped || socket !== this.#socket) return;
      this.#market.setConnection("connected");
      this.#stableTimer = setTimeout(() => {
        if (socket === this.#socket) this.#retryDelay = 1000;
      }, 10000);
      try {
        socket.send(JSON.stringify({ type: "subscribe", channel: "heartbeats" }));
        for (const channel of channels) {
          socket.send(JSON.stringify({ type: "subscribe", channel, product_ids: this.#market.productIds }));
        }
      } catch (error) {
        process.stderr.write(`${new Date().toISOString()} Coinbase subscription failed: ${error.message}\n`);
        socket.close();
      }
    });
    socket.addEventListener("message", (event) => {
      if (socket !== this.#socket) return;
      try {
        this.#market.ingest(JSON.parse(String(event.data)));
      } catch (error) {
        process.stderr.write(`${new Date().toISOString()} Coinbase message ignored: ${error.message}\n`);
      }
    });
    socket.addEventListener("error", (event) => {
      const reason = event.error?.message ?? "falha de rede não informada";
      process.stderr.write(`${new Date().toISOString()} Coinbase WebSocket error: ${reason}\n`);
      if (socket === this.#socket && !this.#stopped) socket.close();
    });
    socket.addEventListener("close", () => {
      if (socket !== this.#socket) return;
      clearTimeout(this.#stableTimer);
      this.#socket = null;
      if (this.#stopped) return;
      process.stderr.write(`${new Date().toISOString()} Coinbase WebSocket closed; retrying\n`);
      this.#scheduleReconnect();
    });
  }

  #scheduleReconnect() {
    if (this.#stopped || this.#retryTimer) return;
    this.#market.setConnection("reconnecting");
    const delay = Math.round(this.#retryDelay * (0.8 + Math.random() * 0.4));
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      this.#connect();
    }, delay);
    this.#retryDelay = Math.min(this.#retryDelay * 2, 30000);
  }
}
