import { MarketRegimeModel } from "./market-regime-model.js";

const definitions = [
  { symbol: "BTCUSD", productId: "BTC-USD", name: "Bitcoin", short: "BTC", color: "#f2b45b" },
  { symbol: "ETHUSD", productId: "ETH-USD", name: "Ethereum", short: "ETH", color: "#9aa9fa" },
  { symbol: "SOLUSD", productId: "SOL-USD", name: "Solana", short: "SOL", color: "#8dd7c1" },
  { symbol: "XRPUSD", productId: "XRP-USD", name: "XRP", short: "XRP", color: "#9aa8b8" },
  { symbol: "ADAUSD", productId: "ADA-USD", name: "Cardano", short: "ADA", color: "#5b9dff" }
];

const number = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const toTimestamp = (value) => {
  const parsed = typeof value === "string" && !Number.isNaN(Number(value)) ? Number(value) : Date.parse(value);
  if (!Number.isFinite(parsed)) return Date.now();
  return parsed < 1000000000000 ? parsed * 1000 : parsed;
};

function rollingCorrelation(left, right) {
  const count = Math.min(left.length, right.length, 60);
  if (count < 2) return 0;
  const leftValues = left.slice(-count);
  const rightValues = right.slice(-count);
  const leftMean = leftValues.reduce((sum, value) => sum + value, 0) / count;
  const rightMean = rightValues.reduce((sum, value) => sum + value, 0) / count;
  let covariance = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (let index = 0; index < count; index += 1) {
    const leftOffset = leftValues[index] - leftMean;
    const rightOffset = rightValues[index] - rightMean;
    covariance += leftOffset * rightOffset;
    leftVariance += leftOffset ** 2;
    rightVariance += rightOffset ** 2;
  }
  const denominator = Math.sqrt(leftVariance * rightVariance);
  return denominator ? covariance / denominator : 0;
}

export class MarketEngine {
  #assets = new Map();
  #trades = new Map();
  #paperLiquidity = new Map();
  #sequence = 0;
  #connection = "connecting";
  #providerMessageAt = null;
  #primaryReconnects = 0;
  #secondaryConnection = "connecting";
  #secondaryMessageAt = null;
  #secondaryReconnects = 0;
  #lastTickerMessageAt = 0;
  #usingFallback = false;
  #lastCorrelationSampleAt = 0;
  #performancePoints = [];
  #lastPerformanceAt = 0;
  #regimeModel = new MarketRegimeModel();

  constructor({ intelligenceEnabled = true } = {}) {
    this.#regimeModel = new MarketRegimeModel(intelligenceEnabled);
    for (const definition of definitions) {
      const asset = { ...definition, price: null, openPrice: null, change: null, high: null, low: null, dayVolume: null, lastTick: null, source: "Coinbase Advanced Trade", candles: [], candlesUpdatedAt: null, returns: [], bids: new Map(), asks: new Map(), bookReady: false, bookUpdatedAt: null, tradesUpdatedAt: null, historyCutoffAt: null };
      this.#assets.set(asset.symbol, asset);
      this.#trades.set(asset.symbol, []);
    }
  }

  get symbols() {
    return [...this.#assets.keys()];
  }

  get productIds() {
    return [...this.#assets.values()].map((asset) => asset.productId);
  }

  get sequence() {
    return this.#sequence;
  }

  get needsRestFallback() {
    return !this.#lastTickerMessageAt || Date.now() - this.#lastTickerMessageAt > 6500;
  }

  exportCache() {
    return {
      schemaVersion: 1,
      savedAt: Date.now(),
      assets: [...this.#assets.values()].map((asset) => ({
        symbol: asset.symbol,
        price: asset.price,
        change: asset.change,
        openPrice: asset.openPrice,
        high: asset.high,
        low: asset.low,
        dayVolume: asset.dayVolume,
        lastTick: asset.lastTick,
        candlesUpdatedAt: asset.candlesUpdatedAt,
        bookUpdatedAt: asset.bookUpdatedAt,
        tradesUpdatedAt: asset.tradesUpdatedAt,
        candles: asset.candles.slice(-350).map(({ time, open, high, low, close, volume }) => ({ time, open, high, low, close, volume })),
        bids: [...asset.bids.entries()].sort((left, right) => right[0] - left[0]).slice(0, 8),
        asks: [...asset.asks.entries()].sort((left, right) => left[0] - right[0]).slice(0, 8),
        trades: this.#trades.get(asset.symbol).slice(0, 40)
      }))
    };
  }

  restoreCache(cache) {
    if (!cache || cache.schemaVersion !== 1 || !Array.isArray(cache.assets)) return 0;
    let restored = 0;
    for (const item of cache.assets) {
      if (!item || typeof item.symbol !== "string") continue;
      const asset = this.#assets.get(item.symbol);
      const price = number(item.price);
      const lastTick = number(item.lastTick);
      if (!asset || !Number.isFinite(price) || price <= 0 || !Number.isFinite(lastTick) || lastTick > Date.now() + 60000) continue;
      asset.price = price;
      asset.change = number(item.change);
      asset.openPrice = number(item.openPrice);
      asset.high = number(item.high);
      asset.low = number(item.low);
      asset.dayVolume = number(item.dayVolume);
      asset.lastTick = lastTick;
      asset.candlesUpdatedAt = null;
      asset.bookUpdatedAt = null;
      asset.tradesUpdatedAt = null;
      if (Array.isArray(item.candles)) {
        asset.candles = item.candles.slice(-350).flatMap((candle) => {
          if (!candle || typeof candle !== "object") return [];
          const normalized = { time: number(candle.time), open: number(candle.open), high: number(candle.high), low: number(candle.low), close: number(candle.close), volume: number(candle.volume) };
          return Object.values(normalized).every(Number.isFinite) ? [{ ...normalized, baseVolume: normalized.volume, liveVolume: 0 }] : [];
        });
      }
      for (const [field, side] of [["bids", asset.bids], ["asks", asset.asks]]) {
        side.clear();
        if (!Array.isArray(item[field])) continue;
        for (const entry of item[field].slice(0, 8)) {
          const levelPrice = number(entry?.[0]);
          const size = number(entry?.[1]);
          if (Number.isFinite(levelPrice) && levelPrice > 0 && Number.isFinite(size) && size > 0) side.set(levelPrice, size);
        }
      }
      asset.bookReady = false;
      this.#trades.set(asset.symbol, []);
      restored += 1;
    }
    if (restored) this.#sequence += 1;
    return restored;
  }

  hasSymbol(symbol) {
    return this.#assets.has(symbol);
  }

  getPrice(symbol) {
    return this.#assets.get(symbol)?.price ?? null;
  }

  getExecutionLevels(symbol, side) {
    const asset = this.#assets.get(symbol);
    if (!asset || !this.hasFreshPrice(symbol) || asset.bookUpdatedAt === null || Date.now() - asset.bookUpdatedAt > 15000 || !asset.bookReady) return [];
    const levels = side === "buy" ? asset.asks : asset.bids;
    return [...levels.entries()]
      .sort((left, right) => side === "buy" ? left[0] - right[0] : right[0] - left[0])
      .slice(0, 50)
      .map(([price, quantity]) => ({ price, quantity }))
      .filter((level) => Number.isFinite(level.price) && Number.isFinite(level.quantity) && level.price > 0 && level.quantity > 0);
  }

  getExecutionBook(symbol, side) {
    const asset = this.#assets.get(symbol);
    if (!asset || asset.source !== "Coinbase Advanced Trade") return null;
    const levels = this.getExecutionLevels(symbol, side);
    if (!asset || !levels.length) return null;
    const key = `${symbol}:${side}:${asset.bookUpdatedAt}`;
    const consumed = this.#paperLiquidity.get(key) ?? new Map();
    return {
      updatedAt: asset.bookUpdatedAt,
      levels: levels.map((level) => ({ ...level, quantity: Math.max(0, level.quantity - (consumed.get(level.price) ?? 0)) })).filter((level) => level.quantity > 0)
    };
  }

  consumeExecutionLiquidity(symbol, side, bookUpdatedAt, fills) {
    const asset = this.#assets.get(symbol);
    if (!asset || asset.bookUpdatedAt !== bookUpdatedAt) return;
    const prefix = `${symbol}:${side}:`;
    for (const key of this.#paperLiquidity.keys()) if (key.startsWith(prefix) && key !== `${prefix}${bookUpdatedAt}`) this.#paperLiquidity.delete(key);
    const key = `${prefix}${bookUpdatedAt}`;
    const consumed = this.#paperLiquidity.get(key) ?? new Map();
    for (const fill of fills) consumed.set(fill.price, (consumed.get(fill.price) ?? 0) + fill.quantity);
    this.#paperLiquidity.set(key, consumed);
  }

  clearAccountPerformance() {
    this.#performancePoints = [];
    this.#lastPerformanceAt = 0;
  }

  restorePerformance(points) {
    if (!Array.isArray(points)) return 0;
    const cutoff = Date.now() - 26 * 60 * 60 * 1000;
    const restored = points.flatMap((point) => {
      const time = number(point?.time);
      const value = number(point?.value);
      return Number.isFinite(time) && Number.isFinite(value) && value >= 0 && time >= cutoff && time <= Date.now() + 60000 ? [{ time, value }] : [];
    }).sort((left, right) => left.time - right.time).slice(-1560);
    this.#performancePoints = restored;
    this.#lastPerformanceAt = restored.at(-1)?.time ?? 0;
    return restored.length;
  }

  exportPerformance() {
    return this.#performancePoints.map((point) => ({ ...point }));
  }

  setHistoryCutoff(cutoffAt) {
    for (const asset of this.#assets.values()) asset.historyCutoffAt = cutoffAt;
  }

  hasFreshPrice(symbol) {
    const asset = this.#assets.get(symbol);
    const now = Date.now();
    const sourceFresh = asset?.source === "Kraken"
      ? this.#secondaryConnection === "online" && this.#secondaryMessageAt !== null && now - this.#secondaryMessageAt <= 10000
      : this.#connection === "online" && this.#providerMessageAt !== null && now - this.#providerMessageAt <= 10000;
    return sourceFresh && Number.isFinite(asset?.price) && asset.lastTick !== null && now - asset.lastTick <= 15000;
  }

  hasFreshExecutionPrice(symbol) {
    const asset = this.#assets.get(symbol);
    return asset?.source === "Coinbase Advanced Trade" && this.hasFreshPrice(symbol);
  }

  setSecondaryConnection(connection) {
    if (connection === "reconnecting" && this.#secondaryConnection !== "reconnecting") this.#secondaryReconnects += 1;
    this.#secondaryConnection = connection;
    this.#sequence += 1;
  }

  ingestSecondaryTicker(ticker) {
    if (!ticker || typeof ticker.symbol !== "string") return false;
    const price = number(ticker.last);
    if (!Number.isFinite(price) || price <= 0) return false;
    const normalized = ticker.symbol.replace("/", "").toUpperCase();
    const asset = [...this.#assets.values()].find((item) => item.symbol === normalized);
    if (!asset) return false;
    this.#secondaryMessageAt = Date.now();
    this.#secondaryConnection = "online";
    const primaryFresh = asset.source === "Coinbase Advanced Trade" && asset.lastTick !== null && Date.now() - asset.lastTick <= 6500;
    if (!primaryFresh) {
      this.#updateTicker({
        product_id: asset.productId,
        price,
        price_percent_chg_24_h: ticker.change_pct,
        high_24_h: ticker.high,
        low_24_h: ticker.low,
        volume_24_h: ticker.volume
      }, "Kraken");
      asset.source = "Kraken";
      this.#usingFallback = true;
    }
    this.#sequence += 1;
    return true;
  }

  setConnection(connection) {
    if (connection === "reconnecting" && this.#connection !== "reconnecting") this.#primaryReconnects += 1;
    this.#connection = connection;
    this.#sequence += 1;
  }

  loadCandles(symbol, candles, cutoffAt) {
    const asset = this.#assets.get(symbol);
    if (!asset || !Array.isArray(candles)) return;
    asset.historyCutoffAt = Number.isFinite(cutoffAt) ? cutoffAt : Date.now();
    for (const candle of candles) this.#upsertCandle(asset, candle);
    if (candles.length) asset.candlesUpdatedAt = Date.now();
    this.#sequence += 1;
  }

  ingest(message) {
    if (!message || typeof message !== "object") return;
    this.#providerMessageAt = Date.now();
    this.#connection = "online";
    const channel = message.channel;
    const events = Array.isArray(message.events) ? message.events : [];
    const tickerSequence = this.#sequence;
    for (const event of events) {
      if (channel === "ticker") {
        for (const ticker of event.tickers ?? []) this.#updateTicker(ticker, "Coinbase Advanced Trade");
      } else if (channel === "l2_data") {
        const asset = [...this.#assets.values()].find((item) => item.productId === event.product_id);
        if (asset) asset.bookUpdatedAt = Date.now();
        this.#updateBook(event, event.product_id);
      } else if (channel === "market_trades") {
        const asset = [...this.#assets.values()].find((item) => item.productId === event.product_id);
        if (asset) asset.tradesUpdatedAt = Date.now();
        for (const trade of event.trades ?? []) this.#updateTrade(trade);
      }
    }
    if (channel === "ticker" && this.#sequence !== tickerSequence) this.#usingFallback = false;
    this.#sequence += 1;
  }

  ingestRestProduct(product) {
    if (!product || typeof product.product_id !== "string") return false;
    const previousSequence = this.#sequence;
    const rawChange = product.price_percentage_change_24h;
    const changeValue = typeof rawChange === "number" ? rawChange : Number.parseFloat(String(rawChange ?? "").replace("%", ""));
    const ticker = {
      product_id: product.product_id,
      price: product.price,
      price_percent_chg_24_h: changeValue,
      volume_24_h: product.volume_24h,
      high_24_h: product.high_24h,
      low_24_h: product.low_24h
    };
    this.#updateTicker(ticker);
    if (this.#sequence === previousSequence) return false;
    this.#providerMessageAt = Date.now();
    this.#connection = "online";
    this.#usingFallback = true;
    this.#sequence += 1;
    return true;
  }

  getSnapshot(symbol, portfolio) {
    const active = this.#assets.get(symbol) ?? this.#assets.get("BTCUSD");
    const assets = [...this.#assets.values()];
    this.#sampleReturns(assets);
    const positionRows = portfolio.positions.map((position) => {
      const asset = this.#assets.get(position.symbol);
      const price = asset && this.hasFreshPrice(position.symbol) ? asset.price : null;
      const value = Number.isFinite(price) ? position.quantity * price : null;
      const pnl = Number.isFinite(price) ? (price - position.averagePrice) * position.quantity : null;
      return { ...position, price, value, pnl, color: asset?.color ?? "#9aa8b8" };
    });
    const positionsValue = positionRows.reduce((sum, position) => sum + (position.value ?? 0), 0);
    const valuationComplete = portfolio.capitalConfigured && positionRows.every((position) => Number.isFinite(position.price));
    const equity = !portfolio.capitalConfigured ? 0 : valuationComplete ? portfolio.cash + positionsValue : null;
    const unrealizedPnl = positionRows.reduce((sum, position) => sum + (position.pnl ?? 0), 0);
    const now = Date.now();
    if (valuationComplete) this.#recordPerformance(equity);
    const dailyTarget = now - 24 * 60 * 60 * 1000;
    const firstPoint = this.#performancePoints[0];
    const dailyReference = this.#performancePoints.find((point) => point.time >= dailyTarget);
    const dailyValuationComplete = portfolio.capitalConfigured && valuationComplete && firstPoint?.time <= dailyTarget + 120000 && !!dailyReference;
    const dailyPnl = !portfolio.capitalConfigured ? 0 : dailyValuationComplete ? equity - dailyReference.value : null;
    const intelligence = this.#regimeModel.infer(assets, this.#sequence, now);
    const primaryOnline = this.#connection === "online" && this.#providerMessageAt !== null && now - this.#providerMessageAt <= 10000;
    const secondaryOnline = this.#secondaryConnection === "online" && this.#secondaryMessageAt !== null && now - this.#secondaryMessageAt <= 10000;
    const feedStatus = primaryOnline || secondaryOnline ? "online" : this.#connection === "connecting" || this.#secondaryConnection === "connecting" ? "connecting" : this.#connection === "reconnecting" || this.#secondaryConnection === "reconnecting" ? "reconnecting" : "stale";
    const freshCoinbaseAssets = assets.filter((asset) => asset.source === "Coinbase Advanced Trade" && this.hasFreshPrice(asset.symbol)).length;
    const freshKrakenAssets = assets.filter((asset) => asset.source === "Kraken" && this.hasFreshPrice(asset.symbol)).length;
    const activeQuoteFresh = this.hasFreshPrice(active.symbol);
    const candlesFresh = active.candlesUpdatedAt !== null && now - active.candlesUpdatedAt <= 15000;
    const bookFresh = active.bookUpdatedAt !== null && now - active.bookUpdatedAt <= 15000;
    const tradesFresh = active.tradesUpdatedAt !== null && now - active.tradesUpdatedAt <= 30000;
    const books = bookFresh ? this.#book(active) : { asks: [], bids: [], ready: false };
    return {
      apiVersion: 1,
      sequence: this.#sequence,
      updatedAt: now,
      connection: feedStatus,
      feed: {
        provider: active.source,
        status: feedStatus,
        quoteFresh: this.hasFreshPrice(active.symbol),
        lastMessageAt: active.source === "Kraken" ? this.#secondaryMessageAt : this.#providerMessageAt,
        marketUpdatedAt: activeQuoteFresh ? active.lastTick : null,
        fallback: this.#usingFallback || active.source === "Kraken",
        sources: {
          coinbase: { status: primaryOnline ? "online" : this.#connection, lastQuoteAt: this.#lastTickerMessageAt || null, freshAssets: freshCoinbaseAssets, reconnects: this.#primaryReconnects },
          kraken: { status: secondaryOnline ? "online" : this.#secondaryConnection, lastQuoteAt: this.#secondaryMessageAt, freshAssets: freshKrakenAssets, reconnects: this.#secondaryReconnects }
        },
        channels: {
          candlesUpdatedAt: candlesFresh ? active.candlesUpdatedAt : null,
          candlesFresh,
          bookUpdatedAt: bookFresh ? active.bookUpdatedAt : null,
          bookFresh,
          tradesUpdatedAt: tradesFresh ? active.tradesUpdatedAt : null,
          tradesFresh
        }
      },
      account: {
        capitalConfigured: portfolio.capitalConfigured,
        capitalEditable: portfolio.capitalEditable,
        hasSimulationData: portfolio.hasSimulationData,
        equity,
        cash: portfolio.cash,
        realizedPnl: portfolio.realizedPnl,
        unrealizedPnl: !portfolio.capitalConfigured ? 0 : valuationComplete ? unrealizedPnl : null,
        totalPnl: !portfolio.capitalConfigured ? 0 : valuationComplete ? portfolio.realizedPnl + unrealizedPnl : null,
        dailyPnl,
        dailyPercent: !portfolio.capitalConfigured ? 0 : dailyValuationComplete && dailyReference.value ? dailyPnl / dailyReference.value * 100 : dailyValuationComplete ? 0 : null,
        dailyReferenceAt: dailyValuationComplete ? dailyReference.time : null,
        buyingPower: portfolio.availableCash,
        positionsValue: !portfolio.capitalConfigured ? 0 : valuationComplete ? positionsValue : null,
        valuationComplete,
        dailyValuationComplete
      },
      markets: assets.map((asset) => {
        const fresh = this.hasFreshPrice(asset.symbol);
        return { symbol: asset.symbol, short: asset.short, name: asset.name, price: fresh ? asset.price : null, change: fresh ? asset.change : null, volume: fresh ? asset.dayVolume : null, color: asset.color, updatedAt: fresh ? asset.lastTick : null, fresh, source: asset.source };
      }),
      active: {
        symbol: active.symbol,
        name: active.name,
        short: active.short,
        source: active.source,
        price: activeQuoteFresh ? active.price : null,
        change: activeQuoteFresh ? active.change : null,
        high: activeQuoteFresh ? active.high : null,
        low: activeQuoteFresh ? active.low : null,
        volume: activeQuoteFresh ? active.dayVolume : null,
        candles: candlesFresh ? active.candles.map(({ time, open, high, low, close, volume }) => ({ time, open, high, low, close, volume })) : [],
        book: { ...books, updatedAt: bookFresh ? active.bookUpdatedAt : null, fresh: bookFresh },
        trades: tradesFresh ? this.#trades.get(active.symbol) : [],
        candlesFresh,
        tradesFresh,
        color: active.color,
        updatedAt: activeQuoteFresh ? active.lastTick : null,
        fresh: activeQuoteFresh
      },
      positions: positionRows,
      orders: portfolio.orders,
      fills: portfolio.fills.slice(0, 18),
      performance: this.#performancePoints,
      network: this.#network(assets, intelligence)
    };
  }

  #updateTicker(ticker, source = "Coinbase Advanced Trade") {
    const asset = [...this.#assets.values()].find((item) => item.productId === ticker.product_id);
    const price = number(ticker.price);
    if (!asset || !Number.isFinite(price) || price <= 0) return;
    const change = number(ticker.price_percent_chg_24_h);
    asset.price = price;
    asset.change = change;
    asset.openPrice = Number.isFinite(change) && change > -100 ? price / (1 + change / 100) : null;
    asset.high = number(ticker.high_24_h) ?? asset.high;
    asset.low = number(ticker.low_24_h) ?? asset.low;
    const volume = number(ticker.volume_24_h);
    asset.dayVolume = Number.isFinite(volume) ? volume : asset.dayVolume;
    asset.source = source;
    asset.lastTick = Date.now();
    if (source === "Coinbase Advanced Trade") this.#lastTickerMessageAt = asset.lastTick;
    this.#sequence += 1;
  }

  #sampleReturns(assets) {
    const now = Date.now();
    if (now - this.#lastCorrelationSampleAt < 1000) return;
    this.#lastCorrelationSampleAt = now;
    for (const asset of assets) {
      if (!this.hasFreshPrice(asset.symbol)) continue;
      const sourceChanged = asset.lastCorrelationSource !== undefined && asset.lastCorrelationSource !== asset.source;
      const observationGap = Number.isFinite(asset.lastCorrelationAt) && now - asset.lastCorrelationAt > 15000;
      if (sourceChanged || observationGap) {
        asset.returns.length = 0;
        asset.lastCorrelationPrice = null;
        asset.lastCorrelationTick = null;
      }
      if (asset.lastCorrelationTick === asset.lastTick) continue;
      if (Number.isFinite(asset.lastCorrelationPrice) && asset.lastCorrelationPrice > 0) {
        asset.returns.push(asset.price / asset.lastCorrelationPrice - 1);
        if (asset.returns.length > 120) asset.returns.shift();
      }
      asset.lastCorrelationPrice = asset.price;
      asset.lastCorrelationTick = asset.lastTick;
      asset.lastCorrelationAt = now;
      asset.lastCorrelationSource = asset.source;
    }
  }

  #updateBook(event, productId) {
    const asset = [...this.#assets.values()].find((item) => item.productId === productId);
    if (!asset) return;
    if (event.type === "snapshot") {
      asset.bids.clear();
      asset.asks.clear();
      asset.bookReady = true;
    }
    for (const update of event.updates ?? []) {
      const side = update.side === "bid" ? asset.bids : asset.asks;
      const price = number(update.price_level);
      const quantity = number(update.new_quantity);
      if (!Number.isFinite(price) || !Number.isFinite(quantity)) continue;
      if (quantity <= 0) side.delete(price);
      else side.set(price, quantity);
    }
    if (asset.bids.size > 500) {
      const distantLevels = [...asset.bids.keys()].sort((left, right) => right - left).slice(500);
      for (const price of distantLevels) asset.bids.delete(price);
    }
    if (asset.asks.size > 500) {
      const distantLevels = [...asset.asks.keys()].sort((left, right) => left - right).slice(500);
      for (const price of distantLevels) asset.asks.delete(price);
    }
  }

  #updateTrade(trade) {
    const asset = [...this.#assets.values()].find((item) => item.productId === trade.product_id);
    const tradePrice = number(trade.price);
    const quantity = number(trade.size);
    if (!asset || !Number.isFinite(tradePrice) || !Number.isFinite(quantity)) return;
    asset.tradesUpdatedAt = Date.now();
    const timestamp = toTimestamp(trade.time);
    const item = { id: trade.trade_id, time: timestamp, price: tradePrice, quantity, side: trade.side === "BUY" ? "sell" : "buy" };
    const tape = this.#trades.get(asset.symbol);
    tape.unshift(item);
    if (tape.length > 100) tape.length = 100;
    if (asset.historyCutoffAt !== null && timestamp <= asset.historyCutoffAt) return;
    asset.candlesUpdatedAt = Date.now();
    const candleTime = Math.floor(timestamp / 60000) * 60000;
    let candle = asset.candles.find((entry) => entry.time === candleTime);
    if (!candle) {
      candle = { time: candleTime, open: tradePrice, high: tradePrice, low: tradePrice, close: tradePrice, volume: 0, baseVolume: 0, liveVolume: 0, firstTradeTime: timestamp, lastTradeTime: timestamp };
      asset.candles.push(candle);
      asset.candles.sort((left, right) => left.time - right.time);
      if (asset.candles.length > 350) asset.candles.splice(0, asset.candles.length - 350);
    }
    candle.high = Math.max(candle.high, tradePrice);
    candle.low = Math.min(candle.low, tradePrice);
    candle.liveVolume = (candle.liveVolume ?? 0) + quantity;
    candle.volume = (candle.baseVolume ?? 0) + candle.liveVolume;
    if (!Number.isFinite(candle.firstTradeTime) || timestamp < candle.firstTradeTime) {
      candle.open = tradePrice;
      candle.firstTradeTime = timestamp;
    }
    if (!Number.isFinite(candle.lastTradeTime) || timestamp >= candle.lastTradeTime) {
      candle.close = tradePrice;
      candle.lastTradeTime = timestamp;
    }
  }

  #upsertCandle(asset, source) {
    const time = toTimestamp(source.start);
    const open = number(source.open);
    const high = number(source.high);
    const low = number(source.low);
    const close = number(source.close);
    const volume = number(source.volume);
    if (![open, high, low, close, volume].every(Number.isFinite)) return;
    const index = asset.candles.findIndex((item) => item.time === time);
    const current = index >= 0 ? asset.candles[index] : null;
    const liveVolume = current?.liveVolume ?? 0;
    const keepLiveClose = current && Number.isFinite(current.lastTradeTime) && current.lastTradeTime > (asset.historyCutoffAt ?? 0);
    const candle = {
      time,
      open,
      high: Math.max(high, current?.high ?? high),
      low: Math.min(low, current?.low ?? low),
      close: keepLiveClose ? current.close : close,
      volume: volume + liveVolume,
      baseVolume: volume,
      liveVolume,
      firstTradeTime: current?.firstTradeTime,
      lastTradeTime: current?.lastTradeTime
    };
    if (index >= 0) asset.candles[index] = candle;
    else asset.candles.push(candle);
    asset.candles.sort((left, right) => left.time - right.time);
    if (asset.candles.length > 350) asset.candles.splice(0, asset.candles.length - 350);
  }

  #book(asset) {
    const asks = [...asset.asks.entries()].sort((left, right) => left[0] - right[0]).slice(0, 8).map(([price, quantity]) => ({ price, quantity }));
    const bids = [...asset.bids.entries()].sort((left, right) => right[0] - left[0]).slice(0, 8).map(([price, quantity]) => ({ price, quantity }));
    return { asks, bids, ready: asset.bookReady };
  }

  #recordPerformance(equity) {
    const now = Date.now();
    if (!this.#performancePoints.length) {
      this.#performancePoints.push({ time: now, value: equity });
      this.#lastPerformanceAt = now;
      return;
    }
    const latest = this.#performancePoints.at(-1);
    if (now - this.#lastPerformanceAt >= 60000) {
      this.#performancePoints.push({ time: now, value: equity });
      this.#lastPerformanceAt = now;
      if (this.#performancePoints.length > 1560) this.#performancePoints.shift();
      return;
    }
    latest.value = equity;
  }

  #network(assets, intelligence) {
    const readyAssets = assets.filter((asset) => this.hasFreshPrice(asset.symbol));
    const regimeBySymbol = new Map(intelligence.assets.map((item) => [item.symbol, item]));
    const nodes = readyAssets.map((asset, index) => {
      const angle = (Math.PI * 2 * index) / Math.max(readyAssets.length, 1) - Math.PI / 2;
      const pulse = Math.min(Math.abs(asset.change ?? 0) / 5, 1);
      const regime = regimeBySymbol.get(asset.symbol);
      return { id: asset.symbol, label: asset.short, x: 0.5 + Math.cos(angle) * 0.36, y: 0.5 + Math.sin(angle) * 0.36, change: asset.change ?? 0, pulse, color: asset.color, price: asset.price, regime: regime?.regime ?? "neutral", confidence: regime?.confidence ?? null, volatility: regime?.volatility ?? null };
    });
    const edges = [];
    for (let left = 0; left < readyAssets.length; left += 1) {
      for (let right = left + 1; right < readyAssets.length; right += 1) {
        const correlation = rollingCorrelation(readyAssets[left].returns, readyAssets[right].returns);
        edges.push({ from: readyAssets[left].symbol, to: readyAssets[right].symbol, strength: Math.abs(correlation), correlation });
      }
    }
    return { nodes, edges, intelligence };
  }
}
