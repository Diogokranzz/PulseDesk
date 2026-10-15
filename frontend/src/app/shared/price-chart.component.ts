import { Component, EventEmitter, Input, Output } from '@angular/core';
import { ActiveMarket, Candle } from '../core/market.types';
import { money, quantity, shortTime, signedPercent } from '../core/format';
import { CoinLogoComponent } from './coin-logo.component';

interface CandleShape {
  time: number;
  x: number;
  bodyX: number;
  frontWidth: number;
  sideWidth: number;
  highY: number;
  lowY: number;
  openY: number;
  closeY: number;
  bodyY: number;
  bodyHeight: number;
  sheenHeight: number;
  volumeY: number;
  volumeHeight: number;
  width: number;
  up: boolean;
}

@Component({
  selector: 'pd-price-chart',
  standalone: true,
  imports: [CoinLogoComponent],
  templateUrl: './price-chart.component.html',
  styles: [':host{display:contents}']
})
export class PriceChartComponent {
  @Input({ required: true }) active!: ActiveMarket;
  @Input() interval = '1m';
  @Input() feedFresh = false;
  @Input() candlesFresh = false;
  @Output() intervalChange = new EventEmitter<string>();
  @Output() symbolSelected = new EventEmitter<string>();

  readonly intervals = ['1m', '5m', '15m', '1h'];
  money = money;
  quantity = quantity;
  shortTime = shortTime;
  signedPercent = signedPercent;

  get bars(): CandleShape[] {
    const candles = this.liveCandles();
    if (!candles.length) return [];
    const currentPrice = this.feedFresh ? this.currentPrice : null;
    const upper = Math.max(...candles.map((candle) => candle.high), currentPrice ?? Number.NEGATIVE_INFINITY);
    const lower = Math.min(...candles.map((candle) => candle.low), currentPrice ?? Number.POSITIVE_INFINITY);
    const span = Math.max(upper - lower, upper * 0.00001, 0.00000001);
    const maximumVolume = Math.max(...candles.map((candle) => candle.volume), 1);
    const step = 824 / candles.length;
    const width = Math.max(2, Math.min(step * 0.62, 11));
    return candles.map((candle, index) => {
      const y = (value: number) => 246 - (value - lower) / span * 214;
      const openY = y(candle.open);
      const closeY = y(candle.close);
      const volumeHeight = Math.max(1, candle.volume / maximumVolume * 38);
      const bodyX = 42 + step * index + step / 2 - width / 2;
      const sideWidth = Math.min(Math.max(width * 0.22, 0.75), 1.8);
      return {
        time: candle.time,
        x: 42 + step * index + step / 2,
        bodyX,
        frontWidth: Math.max(1, width - sideWidth),
        sideWidth,
        highY: y(candle.high), lowY: y(candle.low), openY, closeY,
        bodyY: Math.min(openY, closeY), bodyHeight: Math.max(1, Math.abs(closeY - openY)), sheenHeight: Math.max(Math.abs(closeY - openY) - 2, 0),
        volumeY: 312 - volumeHeight, volumeHeight, width,
        up: candle.close >= candle.open
      };
    });
  }

  get currentPriceY(): number | null {
    const candles = this.liveCandles();
    const price = this.feedFresh ? this.currentPrice : null;
    if (!candles.length || price === null || !Number.isFinite(price)) return null;
    const upper = Math.max(...candles.map((candle) => candle.high), price);
    const lower = Math.min(...candles.map((candle) => candle.low), price);
    const span = Math.max(upper - lower, upper * 0.00001, 0.00000001);
    return 246 - ((price - lower) / span) * 214;
  }

  get currentPriceUp(): boolean {
    const candle = this.liveCandles().at(-1);
    return candle ? (this.currentPrice ?? candle.close) >= candle.open : true;
  }

  get currentPrice(): number | null {
    return this.active?.price ?? null;
  }

  get intervalLabel(): string {
    return this.interval === '1h' ? '1 hora' : this.interval === '15m' ? '15 minutos' : this.interval === '5m' ? '5 minutos' : '1 minuto';
  }

  private aggregateCandles(candles: Candle[]): Candle[] {
    const spanMinutes: Record<string, number> = { '1m': 1, '5m': 5, '15m': 15, '1h': 60 };
    const span = spanMinutes[this.interval] ?? 1;
    if (span === 1) return candles.slice(-76);
    const bucketSize = span * 60_000;
    const groups = new Map<number, Candle>();
    for (const candle of candles) {
      const time = Math.floor(candle.time / bucketSize) * bucketSize;
      const current = groups.get(time);
      if (!current) {
        groups.set(time, { ...candle, time });
      } else {
        current.close = candle.close;
        current.high = Math.max(current.high, candle.high);
        current.low = Math.min(current.low, candle.low);
        current.volume += candle.volume;
      }
    }
    return [...groups.values()].slice(-76);
  }

  private liveCandles(): Candle[] {
    const candles = this.aggregateCandles(this.active?.candles ?? []);
    const price = this.feedFresh ? this.currentPrice : null;
    const updatedAt = this.active?.updatedAt;
    const spanMinutes: Record<string, number> = { '1m': 1, '5m': 5, '15m': 15, '1h': 60 };
    const bucketSize = (spanMinutes[this.interval] ?? 1) * 60_000;
    const currentBucket = Number.isFinite(updatedAt) ? Math.floor((updatedAt as number) / bucketSize) * bucketSize : null;
    const latest = candles.at(-1);
    if (latest && price !== null && Number.isFinite(price) && currentBucket === latest.time) {
      latest.high = Math.max(latest.high, price);
      latest.low = Math.min(latest.low, price);
      latest.close = price;
    }
    return candles;
  }
}
