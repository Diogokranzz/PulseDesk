const endpoint = "wss://ws.kraken.com/v2";
const symbols = ["BTC/USD", "ETH/USD", "SOL/USD", "XRP/USD", "ADA/USD"];

export class KrakenFeed {
  #market;
  #socket = null;
  #retryTimer = null;
  #stableTimer = null;
  #pingTimer = null;
  #retryDelay = 1000;
  #stopped = true;

  constructor(market) {
    this.#market = market;
  }

  start() {
    this.#stopped = false;
    this.#market.setSecondaryConnection("connecting");
    this.#connect();
  }

  stop() {
    this.#stopped = true;
    clearTimeout(this.#retryTimer);
    clearTimeout(this.#stableTimer);
    clearInterval(this.#pingTimer);
    this.#pingTimer = null;
    this.#market.setSecondaryConnection("offline");
    this.#socket?.close();
    this.#socket = null;
  }

  #connect() {
    if (this.#stopped) return;
    this.#market.setSecondaryConnection("connecting");
    let socket;
    try {
      socket = new WebSocket(endpoint);
    } catch (error) {
      process.stderr.write(`${new Date().toISOString()} Kraken connection failed: ${error.message}\n`);
      this.#scheduleReconnect();
      return;
    }
    this.#socket = socket;
    socket.addEventListener("open", () => {
      if (this.#stopped || socket !== this.#socket) return;
      this.#market.setSecondaryConnection("online");
      this.#pingTimer = setInterval(() => {
        if (socket !== this.#socket || socket.readyState !== 1) return;
        try {
          socket.send(JSON.stringify({ method: "ping", req_id: Date.now() }));
        } catch {
          socket.close();
        }
      }, 30000);
      this.#stableTimer = setTimeout(() => {
        if (socket === this.#socket) this.#retryDelay = 1000;
      }, 10000);
      try {
        socket.send(JSON.stringify({ method: "subscribe", params: { channel: "ticker", symbol: symbols, event_trigger: "trades", snapshot: true } }));
        socket.send(JSON.stringify({ method: "subscribe", params: { channel: "heartbeat" } }));
      } catch (error) {
        process.stderr.write(`${new Date().toISOString()} Kraken subscription failed: ${error.message}\n`);
        socket.close();
      }
    });
    socket.addEventListener("message", (event) => {
      if (socket !== this.#socket) return;
      try {
        const message = JSON.parse(String(event.data));
        if (message.method === "pong") {
          this.#market.setSecondaryConnection("online");
          return;
        }
        if (message.channel === "heartbeat") {
          this.#market.setSecondaryConnection("online");
          return;
        }
        if (message.channel !== "ticker" || !Array.isArray(message.data)) return;
        for (const ticker of message.data) this.#market.ingestSecondaryTicker(ticker);
      } catch (error) {
        process.stderr.write(`${new Date().toISOString()} Kraken message ignored: ${error.message}\n`);
      }
    });
    socket.addEventListener("error", (event) => {
      const reason = event.error?.message ?? "falha de rede não informada";
      process.stderr.write(`${new Date().toISOString()} Kraken WebSocket error: ${reason}\n`);
      if (socket === this.#socket && !this.#stopped) socket.close();
    });
    socket.addEventListener("close", () => {
      if (socket !== this.#socket) return;
      clearTimeout(this.#stableTimer);
      clearInterval(this.#pingTimer);
      this.#pingTimer = null;
      this.#socket = null;
      if (this.#stopped) return;
      process.stderr.write(`${new Date().toISOString()} Kraken WebSocket closed; retrying\n`);
      this.#scheduleReconnect();
    });
  }

  #scheduleReconnect() {
    if (this.#stopped || this.#retryTimer) return;
    this.#market.setSecondaryConnection("reconnecting");
    const delay = Math.round(this.#retryDelay * (0.8 + Math.random() * 0.4));
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      this.#connect();
    }, delay);
    this.#retryDelay = Math.min(this.#retryDelay * 2, 30000);
  }
}
