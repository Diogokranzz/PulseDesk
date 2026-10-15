import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { AccountSnapshot, Candle, Fill, MarketIntelligence, MarketQuote, MarketSnapshot, NetworkEdge, NetworkNode, NewOrder, OrderSide, OrderStatus, OrderType, PaperOrder, PerformancePoint, Position, SimulationBackup } from './market.types';
import { BrowserMarketFeed, FeedAsset, MARKET_DEFINITIONS } from './browser-market-feed';
import { MarketRegimeModel } from './market-regime-model';

type ApiConnection = 'connecting' | 'online' | 'degraded' | 'offline';
type AccountOrder = PaperOrder & { idempotencyKey: string; cancelledAt?: number };
type AccountRecord = SimulationBackup['account'] & { orders: AccountOrder[] };
type LocalState = { schemaVersion: 1; account: AccountRecord; performance: PerformancePoint[] };

const storageKey = 'pulsedesk.browser-account.v1';
const feeRate = 0.001;
const maxHistory = 1560;
const mapPositions: Record<string, { x: number; y: number }> = {
  BTCUSD: { x: 0.5, y: 0.15 }, ETHUSD: { x: 0.78, y: 0.37 }, SOLUSD: { x: 0.68, y: 0.72 },
  XRPUSD: { x: 0.32, y: 0.72 }, ADAUSD: { x: 0.22, y: 0.37 }
};

function emptyAccount(): AccountRecord {
  return { capitalConfigured: false, initialCapital: null, cash: 0, realizedPnl: 0, positions: [], orders: [], fills: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function rollingCorrelation(left: number[], right: number[]): number {
  const count = Math.min(left.length, right.length, 60);
  if (count < 2) return 0;
  const a = left.slice(-count);
  const b = right.slice(-count);
  const meanA = a.reduce((sum, value) => sum + value, 0) / count;
  const meanB = b.reduce((sum, value) => sum + value, 0) / count;
  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;
  for (let index = 0; index < count; index += 1) {
    const offsetA = a[index] - meanA;
    const offsetB = b[index] - meanB;
    covariance += offsetA * offsetB;
    varianceA += offsetA ** 2;
    varianceB += offsetB ** 2;
  }
  const denominator = Math.sqrt(varianceA * varianceB);
  return denominator > 0 ? covariance / denominator : 0;
}

@Injectable({ providedIn: 'root' })
export class MarketDataService {
  private readonly destroyRef = inject(DestroyRef);
  private readonly feed = new BrowserMarketFeed();
  private readonly regimeModel = new MarketRegimeModel();
  private account: AccountRecord = emptyAccount();
  private performancePoints: PerformancePoint[] = [];
  private readonly consumedLiquidity = new Map<string, number>();
  private readonly consumedBookTimes = new Map<string, number>();
  private readonly matchedBookTimes = new Map<string, number>();
  private started = false;
  private sequence = 0;
  private readonly bootAt = Date.now();
  private updateTimer: ReturnType<typeof setInterval> | null = null;

  readonly snapshot = signal<MarketSnapshot | null>(null);
  readonly selectedSymbol = signal('BTCUSD');
  readonly apiConnection = signal<ApiConnection>('connecting');
  readonly lastError = signal('');
  readonly updatedAt = signal<number | null>(null);
  readonly marketIsLive = computed(() => Boolean(this.snapshot()?.feed.quoteFresh && this.apiConnection() === 'online'));
  readonly displayMode = computed(() => {
    if (this.marketIsLive()) return 'live';
    const status = this.snapshot()?.feed.status;
    if (status === 'connecting' || status === 'reconnecting') return 'degraded';
    return this.snapshot()?.markets.some((market) => market.price !== null) ? 'stale' : 'offline';
  });

  constructor() {
    this.restoreLocalState();
    this.recalculate();
    window.addEventListener('storage', this.onStorageChange);
    this.destroyRef.onDestroy(() => {
      this.feed.stop();
      if (this.updateTimer) clearInterval(this.updateTimer);
      window.removeEventListener('storage', this.onStorageChange);
    });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.feed.start(() => this.onFeedUpdate());
    this.updateTimer = setInterval(() => this.recalculate(), 1000);
    this.recalculate();
  }

  selectMarket(symbol: string): void {
    if (!this.feed.find(symbol) || symbol === this.selectedSymbol()) return;
    this.selectedSymbol.set(symbol);
    this.recalculate();
  }

  async refresh(): Promise<boolean> {
    const hasQuotes = await this.feed.refresh();
    this.recalculate();
    return hasQuotes;
  }

  async configureCapital(amount: number): Promise<void> {
    if (!Number.isFinite(amount) || amount < 0.01 || amount > 1_000_000_000) throw new Error('Informe um capital entre US$ 0,01 e US$ 1 bilhão.');
    if (this.account.orders.length || this.account.fills.length || this.account.positions.some((position) => position.quantity > 0)) throw new Error('O capital inicial só pode ser alterado antes da primeira operação.');
    this.commitAccount(() => {
      this.account.capitalConfigured = true;
      this.account.initialCapital = amount;
      this.account.cash = amount;
      this.account.realizedPnl = 0;
      this.performancePoints = [];
    });
    this.recalculate();
  }

  async submitOrder(input: NewOrder): Promise<void> {
    if (!this.account.capitalConfigured) throw new Error('Informe o capital inicial antes de enviar ordens paper.');
    if (!input || !this.feed.find(input.symbol) || !['buy', 'sell'].includes(input.side) || !['market', 'limit'].includes(input.type)) throw new Error('Confira o ativo e o tipo da ordem.');
    if (!Number.isFinite(input.quantity) || input.quantity <= 0 || input.quantity > 1_000_000) throw new Error('Informe uma quantidade maior que zero.');
    if (input.type === 'limit' && (!Number.isFinite(input.limitPrice) || (input.limitPrice ?? 0) <= 0)) throw new Error('Informe um preço limite válido.');
    if (this.account.orders.filter((order) => order.status === 'open').length >= 100) throw new Error('Limite de ordens abertas atingido.');
    const previous = this.account.orders.find((order) => order.idempotencyKey === input.idempotencyKey);
    if (previous) return;
    const asset = this.feed.find(input.symbol)!;
    if (!this.feed.isFresh(asset)) throw new Error('A ordem exige uma cotação pública atual para este ativo.');
    if (input.side === 'sell' && input.quantity > this.availableQuantity(input.symbol) + 1e-8) throw new Error('Quantidade disponível insuficiente para venda.');
    if (input.side === 'buy' && input.type === 'limit') {
      const required = input.quantity * (input.limitPrice ?? 0) * (1 + feeRate);
      if (required > this.availableCash() + 1e-6) throw new Error('Saldo disponível insuficiente para reservar esta ordem.');
    }

    this.commitAccount(() => {
      const order: AccountOrder = {
        id: crypto.randomUUID(), symbol: input.symbol, side: input.side, type: input.type, quantity: input.quantity,
        limitPrice: input.type === 'limit' ? input.limitPrice : null, status: input.type === 'limit' ? 'open' : 'filled',
        createdAt: Date.now(), filledAt: null, averageFillPrice: null, filledQuantity: 0, filledNotional: 0, fee: 0,
        strategy: input.strategy, thesis: input.thesis, idempotencyKey: input.idempotencyKey || crypto.randomUUID()
      };
      if (input.type === 'market') order.status = 'open';
      this.account.orders.unshift(order);
      const fills = this.buildFills(order, input.type === 'limit');
      if (input.type === 'market' && (!fills.length || fills.reduce((sum, fill) => sum + fill.quantity, 0) + 1e-8 < order.quantity)) {
        throw new Error('O livro atual não tem profundidade suficiente para preencher toda a ordem a mercado.');
      }
      if (fills.length) {
        this.applyFills(order, fills);
        this.consumeFills(input.symbol, input.side, fills);
      }
      this.trimAccountHistory();
    });
    this.recalculate();
  }

  async cancelOrder(orderId: string): Promise<void> {
    this.commitAccount(() => {
      const order = this.account.orders.find((item) => item.id === orderId);
      if (!order) throw new Error('Ordem não encontrada.');
      if (order.status !== 'open') throw new Error('Somente ordens aguardando execução podem ser canceladas.');
      order.status = 'cancelled';
      order.cancelledAt = Date.now();
    });
    this.recalculate();
  }

  async cancelOpenOrders(): Promise<void> {
    const open = this.account.orders.filter((order) => order.status === 'open');
    if (!open.length) return;
    this.commitAccount(() => {
      for (const order of this.account.orders) if (order.status === 'open') { order.status = 'cancelled'; order.cancelledAt = Date.now(); }
    });
    this.recalculate();
  }

  async resetSimulation(): Promise<void> {
    this.commitAccount(() => { this.account = emptyAccount(); this.performancePoints = []; });
    this.recalculate();
  }

  async exportSimulation(): Promise<SimulationBackup> {
    return { format: 'pulsedesk-simulation', version: 1, exportedAt: Date.now(), account: clone(this.account) };
  }

  async importSimulation(backup: SimulationBackup): Promise<void> {
    const next = this.validateBackup(backup);
    this.commitAccount(() => { this.account = next; this.performancePoints = []; });
    this.recalculate();
  }

  private onFeedUpdate(): void {
    this.processLimitOrders();
    this.recalculate();
  }

  private recalculate(): void {
    const now = Date.now();
    const symbols = MARKET_DEFINITIONS.map((item) => item.symbol);
    const markets = this.feed.markets();
    const activeMarket = markets.find((market) => market.symbol === this.selectedSymbol()) ?? markets[0];
    const activeAsset = this.feed.find(activeMarket.symbol)!;
    const activeFresh = this.feed.isFresh(activeAsset);
    const freshCoinbase = this.feed.assets.filter((asset) => asset.source !== 'Kraken' && this.feed.isFresh(asset)).length;
    const freshKraken = this.feed.assets.filter((asset) => asset.source === 'Kraken' && this.feed.isFresh(asset)).length;
    const primaryOnline = this.feed.coinbaseStatus === 'online' && this.feed.coinbaseMessageAt !== null && now - this.feed.coinbaseMessageAt < 12_000;
    const secondaryOnline = this.feed.krakenStatus === 'online' && this.feed.krakenMessageAt !== null && now - this.feed.krakenMessageAt < 12_000;
    const anyQuote = markets.some((market) => market.fresh);
    const feedStatus = anyQuote ? 'online' : this.feed.coinbaseStatus === 'connecting' || this.feed.krakenStatus === 'connecting' ? 'connecting' : this.feed.coinbaseStatus === 'reconnecting' || this.feed.krakenStatus === 'reconnecting' ? 'reconnecting' : 'stale';
    const positionRows: Position[] = this.account.positions.filter((position) => position.quantity > 1e-8).map((position) => {
      const asset = this.feed.find(position.symbol);
      const price = asset && this.feed.isFresh(asset) ? asset.price : null;
      const value = price === null ? null : position.quantity * price;
      return { ...position, availableQuantity: this.availableQuantity(position.symbol), price, value, pnl: price === null ? null : (price - position.averagePrice) * position.quantity, color: asset?.color ?? '#9aa8b8' };
    });
    const positionsValue = positionRows.reduce((sum, position) => sum + (position.value ?? 0), 0);
    const valuationComplete = this.account.capitalConfigured && positionRows.every((position) => position.price !== null);
    const equity = !this.account.capitalConfigured ? 0 : valuationComplete ? this.account.cash + positionsValue : null;
    const unrealized = positionRows.reduce((sum, position) => sum + (position.pnl ?? 0), 0);
    if (valuationComplete && equity !== null) this.recordPerformance(equity, now);
    const dayTarget = now - 24 * 60 * 60 * 1000;
    const firstPoint = this.performancePoints[0];
    const dayReference = this.performancePoints.find((point) => point.time >= dayTarget);
    const dailyComplete = this.account.capitalConfigured && valuationComplete && firstPoint !== undefined && firstPoint.time <= dayTarget + 120_000 && dayReference !== undefined;
    const dailyPnl = !this.account.capitalConfigured ? 0 : dailyComplete && equity !== null && dayReference ? equity - dayReference.value : null;
    const account: AccountSnapshot = {
      capitalConfigured: this.account.capitalConfigured,
      capitalEditable: this.account.orders.length === 0 && this.account.fills.length === 0,
      hasSimulationData: this.account.capitalConfigured || this.account.orders.length > 0 || this.account.fills.length > 0,
      equity, cash: this.account.capitalConfigured ? this.account.cash : 0,
      buyingPower: this.account.capitalConfigured ? Math.max(0, this.availableCash()) : 0,
      positionsValue, realizedPnl: this.account.capitalConfigured ? this.account.realizedPnl : 0,
      unrealizedPnl: !this.account.capitalConfigured ? 0 : valuationComplete ? unrealized : null,
      totalPnl: !this.account.capitalConfigured ? 0 : valuationComplete ? this.account.realizedPnl + unrealized : null,
      dailyPnl,
      dailyPercent: !this.account.capitalConfigured ? 0 : dailyComplete && dayReference && dailyPnl !== null ? (dayReference.value ? dailyPnl / dayReference.value * 100 : 0) : null,
      dailyReferenceAt: dailyComplete ? dayReference?.time ?? null : null,
      valuationComplete, dailyValuationComplete: dailyComplete
    };
    const intelligence = this.regimeModel.infer(this.feed.assets.map((asset) => ({ symbol: asset.symbol, values: asset.returns })), this.sequence, now);
    const regimeMap = new Map(intelligence.assets.map((asset) => [asset.symbol, asset]));
    const nodes: NetworkNode[] = this.feed.assets.map((asset) => {
      const quote = markets.find((market) => market.symbol === asset.symbol)!;
      const regime = regimeMap.get(asset.symbol);
      const position = mapPositions[asset.symbol] ?? { x: 0.5, y: 0.5 };
      const change = quote.change ?? 0;
      const pulse = Math.min(1, 0.2 + Math.abs(change) / 8 + (regime?.volatility ?? 0) * 10);
      return { id: asset.symbol, label: asset.short, x: position.x, y: position.y, change, pulse, color: asset.color, price: quote.price, regime: regime?.regime ?? 'neutral', confidence: regime?.confidence ?? null, volatility: regime?.volatility ?? null };
    });
    const edges: NetworkEdge[] = [];
    for (let left = 0; left < symbols.length; left += 1) for (let right = left + 1; right < symbols.length; right += 1) {
      const correlation = rollingCorrelation(this.feed.find(symbols[left])?.returns ?? [], this.feed.find(symbols[right])?.returns ?? []);
      edges.push({ from: symbols[left], to: symbols[right], correlation, strength: Math.abs(correlation) });
    }
    const sourceName = activeAsset.source === 'Kraken' ? 'Kraken' : 'Coinbase Advanced Trade';
    const candleFresh = activeAsset.candlesUpdatedAt !== null && now - activeAsset.candlesUpdatedAt <= 90_000;
    const bookFresh = activeAsset.source === 'Coinbase Advanced Trade' && activeAsset.bookUpdatedAt !== null && now - activeAsset.bookUpdatedAt <= 15_000;
    const tradesFresh = activeAsset.tradesUpdatedAt !== null && now - activeAsset.tradesUpdatedAt <= 30_000;
    const asks = bookFresh ? [...activeAsset.asks.entries()].sort((a, b) => a[0] - b[0]).slice(0, 10).map(([price, quantity]) => ({ price, quantity })) : [];
    const bids = bookFresh ? [...activeAsset.bids.entries()].sort((a, b) => b[0] - a[0]).slice(0, 10).map(([price, quantity]) => ({ price, quantity })) : [];
    const snapshot: MarketSnapshot = {
      apiVersion: 1, sequence: this.sequence, updatedAt: now, connection: feedStatus, markets,
      feed: {
        provider: sourceName, status: feedStatus, quoteFresh: activeFresh,
        lastMessageAt: activeAsset.source === 'Kraken' ? this.feed.krakenMessageAt : this.feed.coinbaseMessageAt,
        marketUpdatedAt: activeFresh ? activeAsset.updatedAt : null,
        fallback: this.feed.usingFallback || activeAsset.source === 'Kraken',
        sources: {
          coinbase: { status: this.feed.coinbaseStatus, lastQuoteAt: this.feed.coinbaseMessageAt, freshAssets: freshCoinbase, reconnects: this.feed.coinbaseReconnects },
          kraken: { status: this.feed.krakenStatus, lastQuoteAt: this.feed.krakenMessageAt, freshAssets: freshKraken, reconnects: this.feed.krakenReconnects }
        },
        channels: {
          candlesUpdatedAt: candleFresh ? activeAsset.candlesUpdatedAt : null, candlesFresh: candleFresh,
          bookUpdatedAt: bookFresh ? activeAsset.bookUpdatedAt : null, bookFresh,
          tradesUpdatedAt: tradesFresh ? activeAsset.tradesUpdatedAt : null, tradesFresh
        }
      },
      account, active: {
        ...activeMarket, high: activeFresh ? activeAsset.high : null, low: activeFresh ? activeAsset.low : null,
        candles: clone(activeAsset.candles), candlesFresh: candleFresh,
        book: { asks, bids, ready: bookFresh && (asks.length > 0 || bids.length > 0), updatedAt: bookFresh ? activeAsset.bookUpdatedAt : null, fresh: bookFresh },
        trades: clone(activeAsset.trades), tradesFresh
      },
      positions: positionRows, orders: clone(this.account.orders), fills: clone(this.account.fills), performance: clone(this.performancePoints),
      network: { nodes, edges, intelligence }, operations: { sseConnections: 0, uptimeSeconds: Math.floor((now - this.bootAt) / 1000) }
    };
    this.snapshot.set(snapshot);
    this.updatedAt.set(now);
    this.apiConnection.set(activeFresh ? 'online' : anyQuote ? 'degraded' : this.feed.coinbaseStatus === 'connecting' || this.feed.krakenStatus === 'connecting' || this.feed.coinbaseStatus === 'reconnecting' || this.feed.krakenStatus === 'reconnecting' ? 'degraded' : 'offline');
    if (activeFresh) this.lastError.set('');
    else if (now - this.bootAt > 15_000) this.lastError.set('Sem cotações recentes. Os feeds estão tentando reconectar; sua conta permanece salva neste navegador.');
    this.sequence += 1;
  }

  private availableCash(): number {
    const reserved = this.account.orders.filter((order) => order.status === 'open' && order.side === 'buy' && order.type === 'limit')
      .reduce((sum, order) => sum + Math.max(0, order.quantity - order.filledQuantity) * (order.limitPrice ?? 0) * (1 + feeRate), 0);
    return Math.max(0, this.account.cash - reserved);
  }

  private availableQuantity(symbol: string): number {
    const position = this.account.positions.find((item) => item.symbol === symbol);
    const reserved = this.account.orders.filter((order) => order.symbol === symbol && order.side === 'sell' && order.status === 'open')
      .reduce((sum, order) => sum + Math.max(0, order.quantity - order.filledQuantity), 0);
    return Math.max(0, (position?.quantity ?? 0) - reserved);
  }

  private buildFills(order: AccountOrder, reservationHeld = false): Fill[] {
    const asset = this.feed.find(order.symbol);
    if (!asset || !this.feed.isFresh(asset)) return [];
    const levels = this.feed.getBook(asset, order.side);
    if (!levels.length) return [];
    const bestPrice = levels[0].price;
    if (order.type === 'limit' && (order.side === 'buy' ? bestPrice > (order.limitPrice ?? 0) : bestPrice < (order.limitPrice ?? 0))) return [];
    const remaining = Math.max(0, order.quantity - order.filledQuantity);
    const ownReserve = reservationHeld && order.side === 'buy' && order.type === 'limit' ? remaining * (order.limitPrice ?? 0) * (1 + feeRate) : 0;
    const budget = this.availableCash() + ownReserve;
    const position = this.account.positions.find((item) => item.symbol === order.symbol);
    const otherSellReserve = this.account.orders.filter((item) => item.id !== order.id && item.symbol === order.symbol && item.side === 'sell' && item.status === 'open')
      .reduce((sum, item) => sum + Math.max(0, item.quantity - item.filledQuantity), 0);
    let toFill = Math.min(remaining, order.side === 'sell' ? Math.max(0, (position?.quantity ?? 0) - otherSellReserve) : remaining);
    let spent = 0;
    const fills: Fill[] = [];
    const bookAt = asset.bookUpdatedAt ?? 0;
    const keyPrefix = `${order.symbol}:${order.side}:${bookAt}:`;
    for (const level of levels) {
      if (toFill <= 1e-8) break;
      if (order.type === 'limit' && (order.side === 'buy' ? level.price > (order.limitPrice ?? 0) : level.price < (order.limitPrice ?? 0))) break;
      const key = `${keyPrefix}${level.price}`;
      let quantity = Math.min(toFill, Math.max(0, level.quantity - (this.consumedLiquidity.get(key) ?? 0)));
      if (order.side === 'buy') quantity = Math.min(quantity, Math.max(0, budget - spent) / (level.price * (1 + feeRate)));
      if (quantity <= 1e-8) continue;
      const notional = quantity * level.price;
      fills.push({ id: crypto.randomUUID(), orderId: order.id, symbol: order.symbol, side: order.side, quantity, price: level.price, notional, fee: notional * feeRate, slippageBps: order.side === 'buy' ? (level.price - bestPrice) / bestPrice * 10_000 : (bestPrice - level.price) / bestPrice * 10_000, time: Date.now() });
      toFill -= quantity;
      spent += notional + notional * feeRate;
    }
    return fills;
  }

  private applyFills(order: AccountOrder, fills: Fill[]): void {
    for (const fill of fills) {
      let position = this.account.positions.find((item) => item.symbol === fill.symbol);
      if (!position) {
        position = { symbol: fill.symbol, quantity: 0, averagePrice: 0, dayOpen: fill.price };
        this.account.positions.push(position);
      }
      if (fill.side === 'buy') {
        const totalQuantity = position.quantity + fill.quantity;
        position.averagePrice = (position.quantity * position.averagePrice + fill.notional + fill.fee) / totalQuantity;
        position.quantity = totalQuantity;
        this.account.cash -= fill.notional + fill.fee;
      } else {
        this.account.realizedPnl += (fill.price - position.averagePrice) * fill.quantity - fill.fee;
        position.quantity = Math.max(0, position.quantity - fill.quantity);
        this.account.cash += fill.notional - fill.fee;
      }
      const previousNotional = order.filledNotional ?? (order.filledQuantity * (order.averageFillPrice ?? 0));
      order.filledQuantity += fill.quantity;
      order.filledNotional = previousNotional + fill.notional;
      order.averageFillPrice = order.filledNotional / order.filledQuantity;
      order.fee = (order.fee ?? 0) + fill.fee;
      order.status = order.filledQuantity + 1e-8 >= order.quantity ? 'filled' : 'open';
      order.filledAt = order.status === 'filled' ? fill.time : null;
      this.account.fills.unshift(fill);
      if (position.quantity <= 1e-8) this.account.positions = this.account.positions.filter((item) => item.symbol !== fill.symbol);
    }
  }

  private consumeFills(symbol: string, side: OrderSide, fills: Fill[]): void {
    const asset = this.feed.find(symbol);
    const bookAt = asset?.bookUpdatedAt ?? 0;
    if (this.consumedBookTimes.get(`${symbol}:${side}`) !== bookAt) {
      const prefix = `${symbol}:${side}:`;
      for (const key of this.consumedLiquidity.keys()) if (key.startsWith(prefix)) this.consumedLiquidity.delete(key);
      this.consumedBookTimes.set(`${symbol}:${side}`, bookAt);
    }
    for (const fill of fills) {
      const key = `${symbol}:${side}:${bookAt}:${fill.price}`;
      this.consumedLiquidity.set(key, (this.consumedLiquidity.get(key) ?? 0) + fill.quantity);
    }
  }

  private processLimitOrders(): void {
    let changed = false;
    const previous = clone(this.account);
    const previousConsumedLiquidity = new Map(this.consumedLiquidity);
    const previousConsumedBookTimes = new Map(this.consumedBookTimes);
    const previousMatchedBookTimes = new Map(this.matchedBookTimes);
    for (const asset of this.feed.assets) {
      const bookAt = asset.bookUpdatedAt;
      if (bookAt === null || this.matchedBookTimes.get(asset.symbol) === bookAt) continue;
      this.matchedBookTimes.set(asset.symbol, bookAt);
      for (const order of this.account.orders.filter((item) => item.symbol === asset.symbol && item.status === 'open' && item.type === 'limit')) {
        const fills = this.buildFills(order, true);
        if (!fills.length) continue;
        this.applyFills(order, fills);
        this.consumeFills(order.symbol, order.side, fills);
        changed = true;
      }
    }
    if (changed) {
      try { this.persistLocalState(); }
      catch (error) {
        this.account = previous;
        this.consumedLiquidity.clear();
        for (const [key, value] of previousConsumedLiquidity) this.consumedLiquidity.set(key, value);
        this.consumedBookTimes.clear();
        for (const [key, value] of previousConsumedBookTimes) this.consumedBookTimes.set(key, value);
        this.matchedBookTimes.clear();
        for (const [key, value] of previousMatchedBookTimes) this.matchedBookTimes.set(key, value);
        this.lastError.set(error instanceof Error ? error.message : 'Falha ao salvar a execução no navegador.');
      }
    }
  }

  private commitAccount(operation: () => void): void {
    const previousAccount = clone(this.account);
    const previousPerformance = clone(this.performancePoints);
    const previousConsumedLiquidity = new Map(this.consumedLiquidity);
    const previousConsumedBookTimes = new Map(this.consumedBookTimes);
    try {
      operation();
      this.persistLocalState();
    } catch (error) {
      this.account = previousAccount;
      this.performancePoints = previousPerformance;
      this.consumedLiquidity.clear();
      for (const [key, value] of previousConsumedLiquidity) this.consumedLiquidity.set(key, value);
      this.consumedBookTimes.clear();
      for (const [key, value] of previousConsumedBookTimes) this.consumedBookTimes.set(key, value);
      throw error;
    }
  }

  private persistLocalState(): void {
    try {
      const state: LocalState = { schemaVersion: 1, account: this.account, performance: this.performancePoints.slice(-maxHistory) };
      localStorage.setItem(storageKey, JSON.stringify(state));
    } catch {
      throw new Error('O navegador não conseguiu salvar sua conta. Libere espaço e exporte um backup antes de continuar.');
    }
  }

  private restoreLocalState(): void {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
      if (!isRecord(parsed) || parsed['schemaVersion'] !== 1 || !isRecord(parsed['account'])) return;
      const account = parsed['account'] as unknown as AccountRecord;
      if (typeof account.capitalConfigured !== 'boolean' || !finite(account.cash) || !finite(account.realizedPnl) || !Array.isArray(account.positions) || !Array.isArray(account.orders) || !Array.isArray(account.fills)) return;
      this.account = this.validateBackup({ format: 'pulsedesk-simulation', version: 1, exportedAt: Date.now(), account });
      const performance = Array.isArray(parsed['performance']) ? parsed['performance'] as PerformancePoint[] : [];
      const cutoff = Date.now() - 26 * 60 * 60 * 1000;
      this.performancePoints = performance.filter((point) => point && finite(point.time) && finite(point.value) && point.time >= cutoff && point.value >= 0).sort((a, b) => a.time - b.time).slice(-maxHistory);
    } catch {
      this.lastError.set('A conta salva neste navegador está inválida. Importe um backup para restaurar os dados.');
    }
  }

  private readonly onStorageChange = (event: StorageEvent): void => {
    if (event.key !== storageKey || !event.newValue) return;
    this.restoreLocalState();
    this.recalculate();
  };

  private recordPerformance(equity: number, now: number): void {
    const latest = this.performancePoints.at(-1);
    if (latest && now - latest.time < 60_000) return;
    this.performancePoints.push({ time: now, value: equity });
    const cutoff = now - 26 * 60 * 60 * 1000;
    this.performancePoints = this.performancePoints.filter((point) => point.time >= cutoff).slice(-maxHistory);
    try { this.persistLocalState(); }
    catch { this.lastError.set('O armazenamento do navegador está cheio. Exporte um backup para proteger sua conta.'); }
  }

  private trimAccountHistory(): void {
    if (this.account.fills.length > 500) this.account.fills.length = 500;
    if (this.account.orders.length > 1000) {
      const openOrders = this.account.orders.filter((order) => order.status === 'open');
      const closedOrders = this.account.orders.filter((order) => order.status !== 'open').slice(0, 1000 - openOrders.length);
      this.account.orders = [...openOrders, ...closedOrders];
    }
  }

  private validateBackup(backup: SimulationBackup): AccountRecord {
    if (!isRecord(backup) || backup.format !== 'pulsedesk-simulation' || backup.version !== 1 || !isRecord(backup.account)) throw new Error('Backup de simulação inválido ou incompatível.');
    const source = backup.account as unknown as AccountRecord;
    const symbols = new Set<string>(MARKET_DEFINITIONS.map((asset) => asset.symbol));
    if (typeof source.capitalConfigured !== 'boolean' || !finite(source.cash) || !finite(source.realizedPnl) || !Array.isArray(source.positions) || !Array.isArray(source.orders) || !Array.isArray(source.fills) || source.positions.length > 5 || source.orders.length > 1000 || source.fills.length > 500) throw new Error('O backup contém dados incompletos ou excede os limites locais.');
    if (source.capitalConfigured && (!finite(source.initialCapital) || source.initialCapital < 0.01 || source.initialCapital > 1_000_000_000)) throw new Error('Capital inicial inválido no backup.');
    if (!source.capitalConfigured && (source.cash !== 0 || source.positions.length || source.orders.length || source.fills.length)) throw new Error('A conta sem capital não pode conter ordens ou posições.');
    const positions = source.positions.map((item) => {
      if (!isRecord(item) || typeof item['symbol'] !== 'string' || !symbols.has(item['symbol']) || !finite(item['quantity']) || item['quantity'] < 0 || !finite(item['averagePrice']) || item['averagePrice'] < 0 || !finite(item['dayOpen']) || item['dayOpen'] < 0) throw new Error('Uma posição do backup é inválida.');
      return { symbol: item['symbol'], quantity: item['quantity'], averagePrice: item['averagePrice'], dayOpen: item['dayOpen'] };
    });
    const orders = source.orders.map((item) => {
      if (!isRecord(item) || typeof item['id'] !== 'string' || typeof item['symbol'] !== 'string' || !symbols.has(item['symbol']) || !['buy', 'sell'].includes(String(item['side'])) || !['market', 'limit'].includes(String(item['type'])) || !['open', 'filled', 'cancelled'].includes(String(item['status'])) || !finite(item['quantity']) || item['quantity'] <= 0 || !finite(item['createdAt']) || typeof item['idempotencyKey'] !== 'string') throw new Error('Uma ordem do backup é inválida.');
      const order = item as unknown as AccountOrder;
      if (order.type === 'limit' && (!finite(order.limitPrice) || order.limitPrice <= 0)) throw new Error('Uma ordem limitada do backup tem preço inválido.');
      return clone(order);
    });
    const orderIds = new Set(orders.map((order) => order.id));
    const fills = source.fills.map((item) => {
      if (!isRecord(item) || typeof item['id'] !== 'string' || typeof item['orderId'] !== 'string' || !orderIds.has(item['orderId']) || typeof item['symbol'] !== 'string' || !symbols.has(item['symbol']) || !['buy', 'sell'].includes(String(item['side'])) || !finite(item['quantity']) || item['quantity'] <= 0 || !finite(item['price']) || item['price'] <= 0 || !finite(item['notional']) || !finite(item['fee']) || !finite(item['time'])) throw new Error('Uma execução do backup é inválida.');
      return clone(item as unknown as Fill);
    });
    if (orders.filter((order) => order.status === 'open').length > 100) throw new Error('O backup contém ordens abertas demais.');
    if (source.capitalConfigured) {
      const inventory = positions.reduce((sum, position) => sum + position.quantity * position.averagePrice, 0);
      if (Math.abs(source.cash + inventory - source.realizedPnl - (source.initialCapital ?? 0)) > Math.max(0.01, (source.initialCapital ?? 0) * 1e-8)) throw new Error('Os totais da conta não conferem com o capital inicial do backup.');
    }
    return { capitalConfigured: source.capitalConfigured, initialCapital: source.capitalConfigured ? source.initialCapital : null, cash: source.cash, realizedPnl: source.realizedPnl, positions, orders, fills };
  }
}
