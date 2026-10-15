import { HttpClient } from '@angular/common/http';
import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { BehaviorSubject, EMPTY, Observable, firstValueFrom, forkJoin, merge, timer } from 'rxjs';
import { catchError, distinctUntilChanged, filter, map, retry, switchMap, tap, timeout } from 'rxjs/operators';
import { MarketIntelligence, MarketSnapshot, NetworkNode, NewOrder, OrderSide, OrderStatus, OrderType, SimulationBackup } from './market.types';

type ApiConnection = 'connecting' | 'online' | 'degraded' | 'offline';

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finite(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

function string(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function stringArray<T>(value: unknown, parse: (item: unknown) => T | null): T[] {
  if (!Array.isArray(value)) return [];
  return value.map(parse).filter((item): item is T => item !== null);
}

function normalizeSnapshot(input: unknown): MarketSnapshot | null {
  const root = record(input);
  const account = record(root?.['account']);
  const active = record(root?.['active']);
  if (!root || !account || !active || !Array.isArray(root['markets'])) return null;

  const parseMarket = (value: unknown) => {
    const market = record(value);
    if (!market || typeof market['symbol'] !== 'string') return null;
    return {
      symbol: market['symbol'],
      short: string(market['short'], market['symbol'].replace('USD', '')),
      name: string(market['name'], market['symbol']),
      color: string(market['color'], '#8da0aa'),
      source: string(market['source'], 'Coinbase Advanced Trade'),
      price: finite(market['price']),
      change: finite(market['change']),
      volume: finite(market['volume']),
      updatedAt: finite(market['updatedAt']),
      fresh: market['fresh'] === true
    };
  };

  const markets = stringArray(root['markets'], parseMarket);
  if (!markets.length) return null;

  const activeMarket = parseMarket(active);
  if (!activeMarket) return null;
  const rawBook = record(active['book']);
  const parseLevel = (value: unknown) => {
    const level = record(value);
    const price = finite(level?.['price']);
    const quantity = finite(level?.['quantity']);
    return level && price !== null && quantity !== null ? { price, quantity } : null;
  };
  const parseCandle = (value: unknown) => {
    const candle = record(value);
    const time = finite(candle?.['time']);
    const open = finite(candle?.['open']);
    const high = finite(candle?.['high']);
    const low = finite(candle?.['low']);
    const close = finite(candle?.['close']);
    const volume = finite(candle?.['volume']);
    return candle && time !== null && open !== null && high !== null && low !== null && close !== null && volume !== null
      ? { time, open, high, low, close, volume }
      : null;
  };
  const parseTrade = (value: unknown): MarketSnapshot['active']['trades'][number] | null => {
    const trade = record(value);
    const time = finite(trade?.['time']);
    const price = finite(trade?.['price']);
    const quantity = finite(trade?.['quantity']);
    const side: OrderSide | null = trade?.['side'] === 'sell' ? 'sell' : trade?.['side'] === 'buy' ? 'buy' : null;
    return trade && time !== null && price !== null && quantity !== null && side
      ? { id: string(trade['id'], `${time}-${price}`), time, price, quantity, side }
      : null;
  };
  const parsePosition = (value: unknown) => {
    const position = record(value);
    const quantity = finite(position?.['quantity']);
    const averagePrice = finite(position?.['averagePrice']);
    if (!position || typeof position['symbol'] !== 'string' || quantity === null || averagePrice === null) return null;
    return {
      symbol: position['symbol'], quantity, averagePrice,
      availableQuantity: finite(position['availableQuantity']) ?? quantity,
      price: finite(position['price']), value: finite(position['value']), pnl: finite(position['pnl']),
      color: string(position['color'], '#8da0aa')
    };
  };
  const parseOrder = (value: unknown): MarketSnapshot['orders'][number] | null => {
    const order = record(value);
    if (!order || typeof order['id'] !== 'string' || typeof order['symbol'] !== 'string') return null;
    const side: OrderSide | null = order['side'] === 'sell' ? 'sell' : order['side'] === 'buy' ? 'buy' : null;
    const type: OrderType | null = order['type'] === 'limit' ? 'limit' : order['type'] === 'market' ? 'market' : null;
    const status: OrderStatus | null = order['status'] === 'filled' || order['status'] === 'cancelled' || order['status'] === 'open' ? order['status'] as OrderStatus : null;
    const quantity = finite(order['quantity']);
    const createdAt = finite(order['createdAt']);
    if (!side || !type || !status || quantity === null || createdAt === null) return null;
    return {
      id: order['id'], symbol: order['symbol'], side, type, quantity,
      limitPrice: finite(order['limitPrice']), status, createdAt,
      filledAt: finite(order['filledAt']), averageFillPrice: finite(order['averageFillPrice']),
      filledQuantity: finite(order['filledQuantity']) ?? (status === 'filled' ? quantity : 0),
      filledNotional: finite(order['filledNotional']) ?? undefined,
      fee: finite(order['fee']) ?? undefined,
      strategy: string(order['strategy'], 'discretionary'),
      thesis: string(order['thesis'])
    };
  };
  const parseFill = (value: unknown): MarketSnapshot['fills'][number] | null => {
    const fill = record(value);
    const quantity = finite(fill?.['quantity']);
    const price = finite(fill?.['price']);
    const notional = finite(fill?.['notional']);
    const fee = finite(fill?.['fee']);
    const time = finite(fill?.['time']);
    const side: OrderSide | null = fill?.['side'] === 'sell' ? 'sell' : fill?.['side'] === 'buy' ? 'buy' : null;
    if (!fill || typeof fill['id'] !== 'string' || typeof fill['orderId'] !== 'string' || typeof fill['symbol'] !== 'string' || !side || quantity === null || price === null || notional === null || fee === null || time === null) return null;
    return { id: fill['id'], orderId: fill['orderId'], symbol: fill['symbol'], side, quantity, price, notional, fee, time, slippageBps: finite(fill['slippageBps']) ?? undefined };
  };
  const parsePoint = (value: unknown) => {
    const point = record(value);
    const time = finite(point?.['time']);
    const amount = finite(point?.['value']);
    return point && time !== null && amount !== null ? { time, value: amount } : null;
  };
  const rawNetwork = record(root['network']);
  const rawOperations = record(root['operations']);
  const parseNode = (value: unknown) => {
    const node = record(value);
    const x = finite(node?.['x']);
    const y = finite(node?.['y']);
    const change = finite(node?.['change']);
    const pulse = finite(node?.['pulse']);
    if (!node || typeof node['id'] !== 'string' || x === null || y === null || change === null || pulse === null) return null;
    const regime: NetworkNode['regime'] = node['regime'] === 'bullish' || node['regime'] === 'bearish' ? node['regime'] : 'neutral';
    return { id: node['id'], label: string(node['label']), x, y, change, pulse, color: string(node['color'], '#8da0aa'), price: finite(node['price']), regime, confidence: finite(node['confidence']), volatility: finite(node['volatility']) };
  };
  const rawIntelligence = record(rawNetwork?.['intelligence']);
  const intelligenceStatus: MarketIntelligence['status'] = rawIntelligence?.['status'] === 'ready' ? 'ready' : rawIntelligence?.['status'] === 'disabled' ? 'disabled' : 'warming';
  const intelligence: MarketIntelligence = {
    status: intelligenceStatus,
    algorithm: string(rawIntelligence?.['algorithm'], 'K-means adaptativo'),
    observations: finite(rawIntelligence?.['observations']) ?? 0,
    updatedAt: finite(rawIntelligence?.['updatedAt']),
    volatility: finite(rawIntelligence?.['volatility']) ?? undefined,
    assets: Array.isArray(rawIntelligence?.['assets']) ? rawIntelligence['assets'].flatMap((value) => {
      const item = record(value);
      if (!item || typeof item['symbol'] !== 'string') return [];
      const regime: MarketIntelligence['assets'][number]['regime'] = item['regime'] === 'bullish' || item['regime'] === 'bearish' ? item['regime'] : 'neutral';
      return [{ symbol: item['symbol'], regime, confidence: finite(item['confidence']), volatility: finite(item['volatility']), cluster: finite(item['cluster']) }];
    }) : []
  };
  const parseEdge = (value: unknown) => {
    const edge = record(value);
    const strength = finite(edge?.['strength']);
    const correlation = finite(edge?.['correlation']);
    return edge && typeof edge['from'] === 'string' && typeof edge['to'] === 'string' && strength !== null && correlation !== null
      ? { from: edge['from'], to: edge['to'], strength, correlation }
      : null;
  };
  const rawFeed = record(root['feed']);
  const rawChannels = record(rawFeed?.['channels']);
  const feedStatus = (value: unknown): MarketSnapshot['feed']['status'] =>
    value === 'connecting' || value === 'connected' || value === 'online' || value === 'stale' || value === 'reconnecting' || value === 'offline'
      ? value
      : 'offline';

  return {
    apiVersion: finite(root['apiVersion']) ?? 1,
    sequence: finite(root['sequence']) ?? 0,
    updatedAt: finite(root['updatedAt']) ?? Date.now(),
    connection: feedStatus(root['connection']),
    feed: {
      provider: string(rawFeed?.['provider'], 'Fonte de mercado'),
      status: feedStatus(rawFeed?.['status'] ?? root['connection']),
      quoteFresh: rawFeed?.['quoteFresh'] === true,
      lastMessageAt: finite(rawFeed?.['lastMessageAt']),
      marketUpdatedAt: finite(rawFeed?.['marketUpdatedAt']),
      fallback: rawFeed?.['fallback'] === true,
      sources: (() => {
        const rawSources = record(rawFeed?.['sources']);
        const coinbase = record(rawSources?.['coinbase']);
        const kraken = record(rawSources?.['kraken']);
        return {
          coinbase: { status: feedStatus(coinbase?.['status']), lastQuoteAt: finite(coinbase?.['lastQuoteAt']), freshAssets: finite(coinbase?.['freshAssets']) ?? 0, reconnects: finite(coinbase?.['reconnects']) ?? 0 },
          kraken: { status: feedStatus(kraken?.['status']), lastQuoteAt: finite(kraken?.['lastQuoteAt']), freshAssets: finite(kraken?.['freshAssets']) ?? 0, reconnects: finite(kraken?.['reconnects']) ?? 0 },
        };
      })(),
      channels: {
        candlesUpdatedAt: finite(rawChannels?.['candlesUpdatedAt']),
        candlesFresh: rawChannels?.['candlesFresh'] === true,
        bookUpdatedAt: finite(rawChannels?.['bookUpdatedAt']),
        bookFresh: rawChannels?.['bookFresh'] === true,
        tradesUpdatedAt: finite(rawChannels?.['tradesUpdatedAt']),
        tradesFresh: rawChannels?.['tradesFresh'] === true
      }
    },
    account: {
      capitalConfigured: account['capitalConfigured'] === true,
      capitalEditable: account['capitalEditable'] === true,
      hasSimulationData: account['hasSimulationData'] === true,
      equity: finite(account['equity']), cash: finite(account['cash']), buyingPower: finite(account['buyingPower']),
      positionsValue: finite(account['positionsValue']), realizedPnl: finite(account['realizedPnl']),
      unrealizedPnl: finite(account['unrealizedPnl']), totalPnl: finite(account['totalPnl']),
      dailyPnl: finite(account['dailyPnl']), dailyPercent: finite(account['dailyPercent']), dailyReferenceAt: finite(account['dailyReferenceAt']),
      valuationComplete: account['valuationComplete'] === true,
      dailyValuationComplete: account['dailyValuationComplete'] === true
    },
    markets,
    active: {
      ...activeMarket,
      high: finite(active['high']), low: finite(active['low']),
      candles: stringArray(active['candles'], parseCandle),
      book: {
        asks: stringArray(rawBook?.['asks'], parseLevel), bids: stringArray(rawBook?.['bids'], parseLevel),
        ready: rawBook?.['ready'] === true, updatedAt: finite(rawBook?.['updatedAt']), fresh: rawBook?.['fresh'] === true
      },
      trades: stringArray(active['trades'], parseTrade),
      candlesFresh: active['candlesFresh'] === true,
      tradesFresh: active['tradesFresh'] === true
    },
    positions: stringArray(root['positions'], parsePosition),
    orders: stringArray(root['orders'], parseOrder),
    fills: stringArray(root['fills'], parseFill),
    performance: stringArray(root['performance'], parsePoint),
    network: { nodes: stringArray(rawNetwork?.['nodes'], parseNode), edges: stringArray(rawNetwork?.['edges'], parseEdge), intelligence },
    operations: { sseConnections: finite(rawOperations?.['sseConnections']) ?? 0, uptimeSeconds: finite(rawOperations?.['uptimeSeconds']) ?? 0 }
  };
}

@Injectable({ providedIn: 'root' })
export class MarketDataService {
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);
  private readonly symbolRequests = new BehaviorSubject('BTCUSD');
  private started = false;

  readonly snapshot = signal<MarketSnapshot | null>(null);
  readonly selectedSymbol = signal('BTCUSD');
  readonly apiConnection = signal<ApiConnection>('connecting');
  readonly lastError = signal('');
  readonly updatedAt = signal<number | null>(null);
  readonly marketIsLive = computed(() => {
    const snapshot = this.snapshot();
    return Boolean(this.apiConnection() === 'online' && snapshot?.feed.status === 'online' && snapshot.feed.quoteFresh);
  });
  readonly displayMode = computed(() => {
    const snapshot = this.snapshot();
    if (this.apiConnection() === 'offline' && !snapshot) return 'offline';
    if (this.apiConnection() !== 'online') return 'degraded';
    if (snapshot?.feed.status !== 'online' || !snapshot.feed.quoteFresh) return 'stale';
    return 'live';
  });

  start(): void {
    if (this.started) return;
    this.started = true;
    this.symbolRequests.pipe(
      distinctUntilChanged(),
      switchMap((symbol) => this.connect(symbol)),
      takeUntilDestroyed(this.destroyRef)
    ).subscribe({
      next: (raw) => this.accept(raw),
      error: () => {
        this.updateConnection(this.snapshot() ? 'degraded' : 'offline');
        this.lastError.set('O fluxo de dados foi interrompido. A reconexão continua em andamento.');
      }
    });
  }

  selectMarket(symbol: string): void {
    if (!symbol || symbol === this.selectedSymbol()) return;
    this.selectedSymbol.set(symbol);
    this.symbolRequests.next(symbol);
  }

  async refresh(): Promise<boolean> {
    try {
      const raw = await firstValueFrom(this.http.get<unknown>(this.snapshotUrl(this.selectedSymbol())).pipe(timeout({ first: 5000 })));
      const snapshot = normalizeSnapshot(raw);
      if (!snapshot) throw new Error('A API retornou um pacote incompleto.');
      this.accept(snapshot);
      return true;
    } catch {
      this.updateConnection(this.snapshot() ? 'degraded' : 'offline');
      this.lastError.set(this.snapshot() ? 'API temporariamente indisponível; aguardando reconexão.' : 'Aguardando resposta da API local.');
      return false;
    }
  }

  async configureCapital(amount: number): Promise<void> {
    await firstValueFrom(this.http.post('/api/account/capital', { amount }).pipe(timeout({ first: 5000 })));
    await this.refresh();
  }

  async submitOrder(order: NewOrder): Promise<void> {
    await firstValueFrom(this.http.post('/api/orders', order).pipe(timeout({ first: 5000 })));
    await this.refresh();
  }

  async cancelOrder(orderId: string): Promise<void> {
    await firstValueFrom(this.http.delete(`/api/orders/${encodeURIComponent(orderId)}`).pipe(timeout({ first: 5000 })));
    await this.refresh();
  }

  async cancelOpenOrders(): Promise<void> {
    const orders = this.snapshot()?.orders.filter((order) => order.status === 'open') ?? [];
    if (!orders.length) return;
    await firstValueFrom(forkJoin(orders.map((order) => this.http.delete(`/api/orders/${encodeURIComponent(order.id)}`))).pipe(timeout({ first: 8000 })));
    await this.refresh();
  }

  async resetSimulation(): Promise<void> {
    await firstValueFrom(this.http.post('/api/account/reset', {}).pipe(timeout({ first: 5000 })));
    await this.refresh();
  }

  async exportSimulation(): Promise<SimulationBackup> {
    return firstValueFrom(this.http.get<SimulationBackup>('/api/account/backup').pipe(timeout({ first: 10000 })));
  }

  async importSimulation(backup: SimulationBackup): Promise<void> {
    await firstValueFrom(this.http.post('/api/account/backup', backup).pipe(timeout({ first: 15000 })));
    await this.refresh();
  }

  private connect(symbol: string): Observable<unknown> {
    this.updateConnection(this.snapshot() ? 'degraded' : 'connecting');
    let lastStreamAt = 0;
    const initial = this.http.get<unknown>(this.snapshotUrl(symbol)).pipe(
      timeout({ first: 5000 }),
      catchError(() => {
        this.updateConnection(this.snapshot() ? 'degraded' : 'offline');
        this.lastError.set('API local sem resposta; cotações temporariamente indisponíveis.');
        return EMPTY;
      })
    );
    const live = this.eventStream(symbol).pipe(
      tap(() => { lastStreamAt = Date.now(); }),
      retry({
        delay: (_error, retryCount) => {
          if (Date.now() - (this.updatedAt() ?? 0) > 10000) this.updateConnection(this.snapshot() ? 'degraded' : 'connecting');
          this.lastError.set('Reconectando ao fluxo local…');
          const delayMs = Math.min(1000 * 2 ** Math.min(retryCount, 4), 15000) + Math.floor(Math.random() * 400);
          return timer(delayMs);
        }
      })
    );
    const pollingFallback = timer(1000, 5000).pipe(
      filter(() => Date.now() - lastStreamAt >= 7000),
      switchMap(() => this.http.get<unknown>(this.snapshotUrl(symbol)).pipe(
        timeout({ first: 5000 }),
        catchError(() => {
          if (Date.now() - (this.updatedAt() ?? 0) > 10000) {
            this.updateConnection(this.snapshot() ? 'degraded' : 'offline');
            this.lastError.set('A API local não respondeu; tentando reconectar.');
          }
          return EMPTY;
        })
      ))
    );
    return merge(initial, live, pollingFallback).pipe(
      tap(() => this.apiConnection.set('online')),
      catchError(() => {
        this.updateConnection(this.snapshot() ? 'degraded' : 'offline');
        return EMPTY;
      })
    );
  }

  private eventStream(symbol: string): Observable<unknown> {
    return new Observable<unknown>((observer) => {
      const source = new EventSource(`/api/stream?symbol=${encodeURIComponent(symbol)}`);
      source.addEventListener('snapshot', (event) => {
        try {
          observer.next(JSON.parse((event as MessageEvent<string>).data) as unknown);
        } catch {
          observer.error(new Error('Snapshot SSE inválido'));
        }
      });
      source.onerror = () => {
        source.close();
        observer.error(new Error('Fluxo SSE desconectado'));
      };
      return () => source.close();
    });
  }

  private snapshotUrl(symbol: string): string {
    return `/api/snapshot?symbol=${encodeURIComponent(symbol)}`;
  }

  private updateConnection(connection: ApiConnection): void {
    this.apiConnection.set(connection);
    if (connection === 'online') return;
    this.snapshot.update((snapshot) => {
      if (!snapshot) return null;
      const hasCapital = snapshot.account.capitalConfigured;
      const account = {
        ...snapshot.account,
        equity: hasCapital ? null : 0,
        positionsValue: hasCapital ? null : 0,
        unrealizedPnl: hasCapital ? null : 0,
        totalPnl: hasCapital ? null : 0,
        dailyPnl: hasCapital ? null : 0,
        dailyPercent: hasCapital ? null : 0,
        valuationComplete: false,
        dailyValuationComplete: false
      };
      return {
        ...snapshot,
        updatedAt: Date.now(),
        connection: connection === 'offline' ? 'offline' : 'reconnecting',
        feed: {
          ...snapshot.feed,
          status: connection === 'offline' ? 'offline' : 'reconnecting',
          quoteFresh: false,
          lastMessageAt: null,
          marketUpdatedAt: null,
          fallback: false,
          sources: {
            coinbase: { ...snapshot.feed.sources.coinbase, status: connection === 'offline' ? 'offline' : 'reconnecting', freshAssets: 0 },
            kraken: { ...snapshot.feed.sources.kraken, status: connection === 'offline' ? 'offline' : 'reconnecting', freshAssets: 0 }
          },
          channels: {
            candlesUpdatedAt: null,
            candlesFresh: false,
            bookUpdatedAt: null,
            bookFresh: false,
            tradesUpdatedAt: null,
            tradesFresh: false
          }
        },
        account,
        markets: snapshot.markets.map((market) => ({ ...market, price: null, change: null, volume: null, updatedAt: null, fresh: false })),
        active: {
          ...snapshot.active,
          price: null,
          change: null,
          volume: null,
          high: null,
          low: null,
          updatedAt: null,
          fresh: false,
          candles: [],
          candlesFresh: false,
          book: { asks: [], bids: [], ready: false, updatedAt: null, fresh: false },
          trades: [],
          tradesFresh: false
        },
        positions: snapshot.positions.map((position) => ({ ...position, price: null, value: null, pnl: null })),
        network: { nodes: [], edges: [], intelligence: snapshot.network.intelligence }
      };
    });
  }

  private accept(input: unknown): void {
    const snapshot = normalizeSnapshot(input);
    if (!snapshot) {
      this.updateConnection(this.snapshot() ? 'degraded' : 'offline');
      this.lastError.set('A API enviou dados incompletos; cotações indisponíveis até uma resposta válida.');
      return;
    }
    this.snapshot.set(snapshot);
    this.selectedSymbol.set(snapshot.active.symbol);
    this.apiConnection.set('online');
    this.updatedAt.set(Date.now());
    this.lastError.set('');
  }
}
