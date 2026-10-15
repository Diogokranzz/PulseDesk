import { Candle, FeedStatus, MarketQuote, MarketTrade, OrderSide } from './market.types';

export const MARKET_DEFINITIONS = [
  { symbol: 'BTCUSD', productId: 'BTC-USD', short: 'BTC', name: 'Bitcoin', color: '#f2b45b' },
  { symbol: 'ETHUSD', productId: 'ETH-USD', short: 'ETH', name: 'Ethereum', color: '#9aa9fa' },
  { symbol: 'SOLUSD', productId: 'SOL-USD', short: 'SOL', name: 'Solana', color: '#8dd7c1' },
  { symbol: 'XRPUSD', productId: 'XRP-USD', short: 'XRP', name: 'XRP', color: '#9aa8b8' },
  { symbol: 'ADAUSD', productId: 'ADA-USD', short: 'ADA', name: 'Cardano', color: '#5b9dff' }
] as const;

export interface FeedAsset {
  symbol: string;
  productId: string;
  short: string;
  name: string;
  color: string;
  price: number | null;
  change: number | null;
  volume: number | null;
  high: number | null;
  low: number | null;
  updatedAt: number | null;
  source: string;
  candles: Candle[];
  bids: Map<number, number>;
  asks: Map<number, number>;
  bookUpdatedAt: number | null;
  trades: MarketTrade[];
  tradesUpdatedAt: number | null;
  candlesUpdatedAt: number | null;
  returns: number[];
  lastCandleTime: number | null;
}

function asNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : null;
  return parsed !== null && Number.isFinite(parsed) ? parsed : null;
}

function nestedNumber(value: unknown): number | null {
  if (typeof value === 'object' && value !== null) {
    const object = value as Record<string, unknown>;
    return asNumber(object['24h'] ?? object['today'] ?? object['value']);
  }
  return asNumber(value);
}

function timestamp(value: unknown): number {
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value))) {
    const numeric = Number(value);
    return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  }
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

export class BrowserMarketFeed {
  readonly assets: FeedAsset[] = MARKET_DEFINITIONS.map((definition) => ({
    ...definition, price: null, change: null, volume: null, high: null, low: null, updatedAt: null,
    source: 'Coinbase Advanced Trade', candles: [], bids: new Map(), asks: new Map(), bookUpdatedAt: null,
    trades: [], tradesUpdatedAt: null, candlesUpdatedAt: null, returns: [], lastCandleTime: null
  }));

  coinbaseStatus: FeedStatus = 'connecting';
  krakenStatus: FeedStatus = 'connecting';
  coinbaseReconnects = 0;
  krakenReconnects = 0;
  coinbaseMessageAt: number | null = null;
  krakenMessageAt: number | null = null;
  usingFallback = false;

  private coinbaseSocket: WebSocket | null = null;
  private krakenSocket: WebSocket | null = null;
  private coinbaseRetry: ReturnType<typeof setTimeout> | null = null;
  private krakenRetry: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  private notify: () => void = () => undefined;
  private started = false;
  private closedByUser = false;
  private primaryDelay = 1000;
  private secondaryDelay = 1000;
  private lastHistoryLoadAt = 0;

  start(onUpdate: () => void): void {
    if (this.started) return;
    this.started = true;
    this.closedByUser = false;
    this.notify = onUpdate;
    this.connectCoinbase();
    this.connectKraken();
    void this.loadHistory();
    this.pollTimer = setInterval(() => void this.pollStaleQuotes(), 12_000);
    this.reconnectTimer = setInterval(() => this.refreshStaleStatus(), 1500);
  }

  stop(): void {
    this.closedByUser = true;
    this.started = false;
    for (const timer of [this.coinbaseRetry, this.krakenRetry, this.pollTimer, this.reconnectTimer, this.notifyTimer]) if (timer) clearTimeout(timer as ReturnType<typeof setTimeout>);
    this.coinbaseRetry = this.krakenRetry = this.reconnectTimer = this.notifyTimer = null;
    this.pollTimer = null;
    this.coinbaseSocket?.close();
    this.krakenSocket?.close();
    this.coinbaseSocket = this.krakenSocket = null;
  }

  async refresh(): Promise<boolean> {
    await Promise.allSettled([this.loadHistory(true), this.pollStaleQuotes(true)]);
    this.refreshStaleStatus();
    this.changed();
    return this.assets.some((asset) => this.isFresh(asset));
  }

  find(symbol: string): FeedAsset | undefined {
    return this.assets.find((asset) => asset.symbol === symbol);
  }

  isFresh(asset: FeedAsset): boolean {
    if (asset.price === null || asset.updatedAt === null || Date.now() - asset.updatedAt > 15_000) return false;
    const providerAt = asset.source === 'Kraken' ? this.krakenMessageAt : this.coinbaseMessageAt;
    const providerStatus = asset.source === 'Kraken' ? this.krakenStatus : this.coinbaseStatus;
    return providerStatus === 'online' && providerAt !== null && Date.now() - providerAt <= 12_000;
  }

  getBook(asset: FeedAsset, side: OrderSide): Array<{ price: number; quantity: number }> {
    if (asset.source !== 'Coinbase Advanced Trade' || !this.isFresh(asset) || asset.bookUpdatedAt === null || Date.now() - asset.bookUpdatedAt > 15_000) return [];
    const levels = [...(side === 'buy' ? asset.asks : asset.bids).entries()]
      .sort((left, right) => side === 'buy' ? left[0] - right[0] : right[0] - left[0])
      .slice(0, 50)
      .map(([price, quantity]) => ({ price, quantity }))
      .filter((level) => level.price > 0 && level.quantity > 0);
    return levels;
  }

  markets(): MarketQuote[] {
    return this.assets.map((asset) => {
      const fresh = this.isFresh(asset);
      return {
        symbol: asset.symbol, short: asset.short, name: asset.name, color: asset.color,
        source: asset.source, price: fresh ? asset.price : null, change: fresh ? asset.change : null,
        volume: fresh ? asset.volume : null, updatedAt: fresh ? asset.updatedAt : null, fresh
      };
    });
  }

  private connectCoinbase(): void {
    if (this.closedByUser) return;
    if (typeof WebSocket === 'undefined') { this.coinbaseStatus = 'offline'; this.changed(); return; }
    this.coinbaseStatus = 'connecting';
    this.changed();
    let socket: WebSocket;
    try { socket = new WebSocket('wss://advanced-trade-ws.coinbase.com'); }
    catch { this.scheduleCoinbaseReconnect(); return; }
    this.coinbaseSocket = socket;
    socket.addEventListener('open', () => {
      if (socket !== this.coinbaseSocket) return;
      this.coinbaseStatus = 'online';
      this.primaryDelay = 1000;
      socket.send(JSON.stringify({ type: 'subscribe', channel: 'heartbeats' }));
      for (const channel of ['ticker', 'level2', 'market_trades']) {
        socket.send(JSON.stringify({ type: 'subscribe', channel, product_ids: MARKET_DEFINITIONS.map((asset) => asset.productId) }));
      }
      this.changed();
    });
    socket.addEventListener('message', (event) => {
      if (socket !== this.coinbaseSocket) return;
      try { this.handleCoinbase(JSON.parse(String(event.data)) as Record<string, unknown>); }
      catch { /* Ignore malformed provider messages and keep the socket alive. */ }
    });
    socket.addEventListener('error', () => socket.close());
    socket.addEventListener('close', () => {
      if (socket !== this.coinbaseSocket) return;
      this.coinbaseSocket = null;
      if (this.closedByUser) return;
      this.coinbaseStatus = 'reconnecting';
      this.coinbaseReconnects += 1;
      this.scheduleCoinbaseReconnect();
    });
  }

  private scheduleCoinbaseReconnect(): void {
    if (this.closedByUser || this.coinbaseRetry) return;
    this.coinbaseStatus = 'reconnecting';
    const delay = this.primaryDelay * (0.85 + Math.random() * 0.3);
    this.coinbaseRetry = setTimeout(() => { this.coinbaseRetry = null; this.connectCoinbase(); }, delay);
    this.primaryDelay = Math.min(this.primaryDelay * 2, 30_000);
    this.changed();
  }

  private handleCoinbase(message: Record<string, unknown>): void {
    const now = Date.now();
    this.coinbaseMessageAt = now;
    this.coinbaseStatus = 'online';
    const channel = message['channel'];
    const events = Array.isArray(message['events']) ? message['events'] as Array<Record<string, unknown>> : [];
    for (const event of events) {
      if (channel === 'ticker') {
        const tickers = Array.isArray(event['tickers']) ? event['tickers'] as Array<Record<string, unknown>> : [];
        for (const ticker of tickers) this.applyCoinbaseTicker(ticker, now);
      } else if (channel === 'l2_data') {
        this.applyBookEvent(event, now);
      } else if (channel === 'market_trades') {
        const trades = Array.isArray(event['trades']) ? event['trades'] as Array<Record<string, unknown>> : [];
        const asset = this.assets.find((item) => item.productId === event['product_id']);
        if (asset) for (const trade of trades) this.applyTrade(asset, trade);
      }
    }
    this.changed();
  }

  private applyCoinbaseTicker(ticker: Record<string, unknown>, now: number): void {
    const asset = this.assets.find((item) => item.productId === ticker['product_id']);
    const price = asNumber(ticker['price']);
    if (!asset || price === null || price <= 0) return;
    asset.price = price;
    asset.change = asNumber(ticker['price_percent_chg_24_h']);
    asset.volume = asNumber(ticker['volume_24_h']);
    asset.high = asNumber(ticker['high_24_h']) ?? asset.high;
    asset.low = asNumber(ticker['low_24_h']) ?? asset.low;
    asset.updatedAt = now;
    asset.source = 'Coinbase Advanced Trade';
    this.usingFallback = false;
    this.updateCandle(asset, price, 0, now);
  }

  private applyBookEvent(event: Record<string, unknown>, now: number): void {
    const asset = this.assets.find((item) => item.productId === event['product_id']);
    if (!asset) return;
    if (event['type'] === 'snapshot' || event['event_type'] === 'snapshot') { asset.bids.clear(); asset.asks.clear(); }
    const updates = Array.isArray(event['updates']) ? event['updates'] as Array<Record<string, unknown>> : [];
    for (const update of updates) {
      const price = asNumber(update['price_level'] ?? update['price']);
      const quantity = asNumber(update['new_quantity'] ?? update['quantity']);
      if (price === null || quantity === null || price <= 0) continue;
      const side = String(update['side'] ?? '').toLowerCase();
      const levels = side === 'bid' ? asset.bids : asset.asks;
      if (quantity <= 0) levels.delete(price); else levels.set(price, quantity);
    }
    this.trimBook(asset.bids, true);
    this.trimBook(asset.asks, false);
    asset.bookUpdatedAt = now;
  }

  private trimBook(levels: Map<number, number>, bids: boolean): void {
    if (levels.size <= 120) return;
    const keep = [...levels.keys()].sort((left, right) => bids ? right - left : left - right).slice(0, 120);
    const keepSet = new Set(keep);
    for (const price of levels.keys()) if (!keepSet.has(price)) levels.delete(price);
  }

  private applyTrade(asset: FeedAsset, trade: Record<string, unknown>): void {
    const price = asNumber(trade['price']);
    const quantity = asNumber(trade['size'] ?? trade['quantity']);
    const time = timestamp(trade['time'] ?? trade['trade_time']);
    if (price === null || quantity === null || price <= 0 || quantity <= 0) return;
    const side: OrderSide = String(trade['side'] ?? '').toUpperCase() === 'BUY' ? 'buy' : 'sell';
    const id = String(trade['trade_id'] ?? trade['tradeId'] ?? `${time}-${price}-${quantity}`);
    asset.trades.unshift({ id, time, price, quantity, side });
    if (asset.trades.length > 40) asset.trades.length = 40;
    asset.tradesUpdatedAt = Date.now();
    this.updateCandle(asset, price, quantity, time);
  }

  private updateCandle(asset: FeedAsset, price: number, volume: number, time: number): void {
    const minute = Math.floor(time / 60_000) * 60_000;
    let candle = asset.candles.at(-1);
    if (!candle || candle.time !== minute) {
      if (candle && price > 0) {
        const change = Math.log(price / candle.close);
        if (Number.isFinite(change)) asset.returns.push(change);
      }
      candle = { time: minute, open: price, high: price, low: price, close: price, volume: 0 };
      asset.candles.push(candle);
      if (asset.candles.length > 350) asset.candles.splice(0, asset.candles.length - 350);
      asset.lastCandleTime = minute;
      if (asset.returns.length > 240) asset.returns.splice(0, asset.returns.length - 240);
    }
    candle.high = Math.max(candle.high, price);
    candle.low = Math.min(candle.low, price);
    candle.close = price;
    candle.volume += Math.max(volume, 0);
    asset.candlesUpdatedAt = Date.now();
  }

  private connectKraken(): void {
    if (this.closedByUser) return;
    if (typeof WebSocket === 'undefined') { this.krakenStatus = 'offline'; return; }
    this.krakenStatus = 'connecting';
    let socket: WebSocket;
    try { socket = new WebSocket('wss://ws.kraken.com/v2'); }
    catch { this.scheduleKrakenReconnect(); return; }
    this.krakenSocket = socket;
    socket.addEventListener('open', () => {
      if (socket !== this.krakenSocket) return;
      this.krakenStatus = 'online';
      this.secondaryDelay = 1000;
      socket.send(JSON.stringify({ method: 'subscribe', params: { channel: 'ticker', symbol: MARKET_DEFINITIONS.map((asset) => `${asset.short}/USD`), event_trigger: 'trades', snapshot: true } }));
      // Kraken sends heartbeat frames automatically after any channel is subscribed.
      this.changed();
    });
    socket.addEventListener('message', (event) => {
      if (socket !== this.krakenSocket) return;
      try { this.handleKraken(JSON.parse(String(event.data)) as Record<string, unknown>); }
      catch { /* Ignore malformed provider messages. */ }
    });
    socket.addEventListener('error', () => socket.close());
    socket.addEventListener('close', () => {
      if (socket !== this.krakenSocket) return;
      this.krakenSocket = null;
      if (this.closedByUser) return;
      this.krakenStatus = 'reconnecting';
      this.krakenReconnects += 1;
      this.scheduleKrakenReconnect();
    });
  }

  private scheduleKrakenReconnect(): void {
    if (this.closedByUser || this.krakenRetry) return;
    this.krakenStatus = 'reconnecting';
    const delay = this.secondaryDelay * (0.85 + Math.random() * 0.3);
    this.krakenRetry = setTimeout(() => { this.krakenRetry = null; this.connectKraken(); }, delay);
    this.secondaryDelay = Math.min(this.secondaryDelay * 2, 30_000);
    this.changed();
  }

  private handleKraken(message: Record<string, unknown>): void {
    const channel = message['channel'];
    if (channel === 'heartbeat' || message['method'] === 'pong') { this.krakenMessageAt = Date.now(); this.krakenStatus = 'online'; this.changed(); return; }
    if (channel !== 'ticker' || !Array.isArray(message['data'])) return;
    const now = Date.now();
    this.krakenMessageAt = now;
    this.krakenStatus = 'online';
    for (const row of message['data'] as Array<Record<string, unknown>>) {
      const symbol = String(row['symbol'] ?? '').replace('/', '').toUpperCase();
      const asset = this.assets.find((item) => item.symbol === symbol);
      const price = nestedNumber(row['last']);
      if (!asset || price === null || price <= 0) continue;
      const primaryFresh = asset.source === 'Coinbase Advanced Trade' && asset.updatedAt !== null && now - asset.updatedAt <= 10_000;
      if (primaryFresh) continue;
      asset.price = price;
      asset.change = nestedNumber(row['change_pct'] ?? row['change']);
      asset.volume = nestedNumber(row['volume']);
      asset.high = nestedNumber(row['high']) ?? asset.high;
      asset.low = nestedNumber(row['low']) ?? asset.low;
      asset.updatedAt = now;
      asset.source = 'Kraken';
      this.usingFallback = true;
      this.updateCandle(asset, price, 0, now);
    }
    this.changed();
  }

  private async loadHistory(force = false): Promise<void> {
    if (!force && Date.now() - this.lastHistoryLoadAt < 60_000) return;
    this.lastHistoryLoadAt = Date.now();
    const end = Math.floor(Date.now() / 1000);
    const start = end - 350 * 60;
    await Promise.allSettled(this.assets.map(async (asset) => {
      const params = new URLSearchParams({ start: String(start), end: String(end), granularity: 'ONE_MINUTE', limit: '350' });
      const response = await fetch(`https://api.coinbase.com/api/v3/brokerage/market/products/${encodeURIComponent(asset.productId)}/candles?${params}`, { signal: AbortSignal.timeout(10_000), headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`Coinbase respondeu ${response.status}`);
      const result = await response.json() as { candles?: Array<Record<string, unknown>> };
      if (!Array.isArray(result.candles)) return;
      const historical = result.candles.flatMap((candle) => {
        const open = asNumber(candle['open']);
        const high = asNumber(candle['high']);
        const low = asNumber(candle['low']);
        const close = asNumber(candle['close']);
        const volume = asNumber(candle['volume']);
        const time = timestamp(candle['start']);
        return open !== null && high !== null && low !== null && close !== null && volume !== null && open > 0
          ? [{ time: Math.floor(time / 60_000) * 60_000, open, high, low, close, volume }]
          : [];
      }).sort((left, right) => left.time - right.time).slice(-350);
      if (historical.length) {
        asset.candles = historical;
        asset.candlesUpdatedAt = Date.now();
        asset.returns = historical.slice(1).flatMap((candle, index) => {
          const previous = historical[index].close;
          const value = Math.log(candle.close / previous);
          return Number.isFinite(value) ? [value] : [];
        }).slice(-240);
        asset.lastCandleTime = historical.at(-1)?.time ?? null;
      }
    }));
    this.changed();
  }

  private async pollStaleQuotes(force = false): Promise<void> {
    const stale = this.assets.filter((asset) => force || !this.isFresh(asset));
    await Promise.allSettled(stale.map(async (asset) => {
      const response = await fetch(`https://api.coinbase.com/api/v3/brokerage/market/products/${encodeURIComponent(asset.productId)}`, { signal: AbortSignal.timeout(5000), headers: { Accept: 'application/json' } });
      if (!response.ok) return;
      const body = await response.json() as { product?: Record<string, unknown> };
      const product = (body.product ?? body) as Record<string, unknown>;
      const price = asNumber(product['price']);
      if (price === null || price <= 0) return;
      const now = Date.now();
      const coinbaseRecentlyFresh = asset.source === 'Coinbase Advanced Trade' && asset.updatedAt !== null && now - asset.updatedAt <= 10_000;
      if (coinbaseRecentlyFresh) return;
      asset.price = price;
      const changeText = product['price_percentage_change_24h'];
      asset.change = typeof changeText === 'string' ? Number.parseFloat(changeText.replace('%', '')) : asNumber(changeText);
      asset.volume = asNumber(product['volume_24h']);
      asset.high = asNumber(product['high_24h']) ?? asset.high;
      asset.low = asNumber(product['low_24h']) ?? asset.low;
      asset.updatedAt = now;
      asset.source = 'Coinbase REST público';
      this.coinbaseStatus = 'online';
      this.coinbaseMessageAt = now;
      this.updateCandle(asset, price, 0, now);
    }));
    this.changed();
  }

  private refreshStaleStatus(): void {
    const now = Date.now();
    if (this.coinbaseMessageAt !== null && now - this.coinbaseMessageAt > 12_000 && this.coinbaseStatus === 'online') this.coinbaseStatus = 'stale';
    if (this.krakenMessageAt !== null && now - this.krakenMessageAt > 12_000 && this.krakenStatus === 'online') this.krakenStatus = 'stale';
    this.changed();
  }

  private changed(): void {
    if (!this.notifyTimer) this.notifyTimer = setTimeout(() => { this.notifyTimer = null; this.notify(); }, 250);
  }
}
