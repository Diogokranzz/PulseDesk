export type FeedStatus = 'connecting' | 'connected' | 'online' | 'stale' | 'reconnecting' | 'offline';
export type OrderSide = 'buy' | 'sell';
export type OrderType = 'market' | 'limit';
export type OrderStatus = 'open' | 'filled' | 'cancelled';

export interface MarketQuote {
  symbol: string;
  short: string;
  name: string;
  color: string;
  source: string;
  price: number | null;
  change: number | null;
  volume: number | null;
  updatedAt: number | null;
  fresh: boolean;
}

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface BookLevel {
  price: number;
  quantity: number;
}

export interface MarketTrade {
  id: string;
  time: number;
  price: number;
  quantity: number;
  side: OrderSide;
}

export interface ActiveMarket extends MarketQuote {
  high: number | null;
  low: number | null;
  candles: Candle[];
  book: { asks: BookLevel[]; bids: BookLevel[]; ready: boolean; updatedAt: number | null; fresh: boolean };
  trades: MarketTrade[];
  candlesFresh: boolean;
  tradesFresh: boolean;
}

export interface AccountSnapshot {
  capitalConfigured: boolean;
  capitalEditable: boolean;
  hasSimulationData: boolean;
  equity: number | null;
  cash: number | null;
  buyingPower: number | null;
  positionsValue: number | null;
  realizedPnl: number | null;
  unrealizedPnl: number | null;
  totalPnl: number | null;
  dailyPnl: number | null;
  dailyPercent: number | null;
  dailyReferenceAt: number | null;
  valuationComplete: boolean;
  dailyValuationComplete: boolean;
}

export interface Position {
  symbol: string;
  quantity: number;
  averagePrice: number;
  availableQuantity: number;
  price: number | null;
  value: number | null;
  pnl: number | null;
  color: string;
}

export interface PaperOrder {
  id: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  limitPrice: number | null;
  status: OrderStatus;
  createdAt: number;
  filledAt: number | null;
  averageFillPrice: number | null;
  filledQuantity: number;
  filledNotional?: number;
  fee?: number;
  strategy?: string;
  thesis?: string;
}

export interface Fill {
  id: string;
  orderId: string;
  symbol: string;
  side: OrderSide;
  quantity: number;
  price: number;
  notional: number;
  fee: number;
  slippageBps?: number;
  time: number;
}

export interface PerformancePoint {
  time: number;
  value: number;
}

export interface NetworkNode {
  id: string;
  label: string;
  x: number;
  y: number;
  change: number;
  pulse: number;
  color: string;
  price: number | null;
  regime: 'bullish' | 'bearish' | 'neutral';
  confidence: number | null;
  volatility: number | null;
}

export interface MarketIntelligence {
  status: 'warming' | 'ready' | 'disabled';
  algorithm: string;
  observations: number;
  updatedAt: number | null;
  volatility?: number;
  assets: Array<{ symbol: string; regime: 'bullish' | 'bearish' | 'neutral'; confidence: number | null; volatility: number | null; cluster?: number | null }>;
}

export interface NetworkEdge {
  from: string;
  to: string;
  strength: number;
  correlation: number;
}

export interface MarketSnapshot {
  apiVersion: number;
  sequence: number;
  updatedAt: number;
  connection: FeedStatus;
  feed: {
    provider: string;
    status: FeedStatus;
    quoteFresh: boolean;
    lastMessageAt: number | null;
    marketUpdatedAt: number | null;
    fallback: boolean;
    sources: {
      coinbase: { status: FeedStatus; lastQuoteAt: number | null; freshAssets: number; reconnects: number };
      kraken: { status: FeedStatus; lastQuoteAt: number | null; freshAssets: number; reconnects: number };
    };
    channels: {
      candlesUpdatedAt: number | null;
      candlesFresh: boolean;
      bookUpdatedAt: number | null;
      bookFresh: boolean;
      tradesUpdatedAt: number | null;
      tradesFresh: boolean;
    };
  };
  account: AccountSnapshot;
  markets: MarketQuote[];
  active: ActiveMarket;
  positions: Position[];
  orders: PaperOrder[];
  fills: Fill[];
  performance: PerformancePoint[];
  network: { nodes: NetworkNode[]; edges: NetworkEdge[]; intelligence: MarketIntelligence };
  operations: { sseConnections: number; uptimeSeconds: number };
}

export interface HealthSnapshot {
  status: 'ok';
  mode: 'paper';
  time: number;
  market: MarketSnapshot['feed'];
  streams: number;
}

export interface NewOrder {
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  limitPrice: number | null;
  strategy: string;
  thesis: string;
  idempotencyKey: string;
}

export interface SimulationBackup {
  format: 'pulsedesk-simulation';
  version: 1;
  exportedAt: number;
  account: {
    capitalConfigured: boolean;
    initialCapital: number | null;
    cash: number;
    realizedPnl: number;
    positions: Array<{ symbol: string; quantity: number; averagePrice: number; dayOpen: number }>;
    orders: Array<PaperOrder & { idempotencyKey: string; fee?: number; cancelledAt?: number }>;
    fills: Fill[];
  };
}

export interface PulseDeskBackup {
  format: 'pulsedesk-backup';
  version: 1;
  exportedAt: number;
  profile: { name: string; avatar: string | null };
  simulation: SimulationBackup;
}
