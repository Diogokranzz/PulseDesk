import { AfterViewInit, Component, ElementRef, EventEmitter, Input, Output, ViewChild } from '@angular/core';
import { ActiveMarket, MarketQuote } from '../core/market.types';
import { money, quantity, shortTime, signedPercent } from '../core/format';
import { CoinLogoComponent } from './coin-logo.component';

@Component({
  selector: 'pd-market-details-dialog',
  standalone: true,
  imports: [CoinLogoComponent],
  templateUrl: './market-details-dialog.component.html',
  styles: [':host{display:contents}']
})
export class MarketDetailsDialogComponent implements AfterViewInit {
  @ViewChild('marketDialog') private marketDialog?: ElementRef<HTMLDialogElement>;
  @Input({ required: true }) quote!: MarketQuote;
  @Input() active: ActiveMarket | null = null;
  @Input() feedFresh = false;
  @Input() provider = 'Feed público';
  @Output() closed = new EventEmitter<void>();

  readonly money = money;
  readonly quantity = quantity;
  readonly shortTime = shortTime;
  readonly signedPercent = signedPercent;

  ngAfterViewInit(): void {
    const dialog = this.marketDialog?.nativeElement;
    if (dialog && !dialog.open) dialog.showModal();
  }

  get activeForQuote(): ActiveMarket | null {
    return this.active?.symbol === this.quote?.symbol ? this.active : null;
  }

  get currentPrice(): number | null {
    return this.activeForQuote?.price ?? this.quote?.price ?? null;
  }

  get currentChange(): number | null {
    return this.activeForQuote?.change ?? this.quote?.change ?? null;
  }

  get currentVolume(): number | null {
    return this.activeForQuote?.volume ?? this.quote?.volume ?? null;
  }

  get currentUpdatedAt(): number | null {
    return this.activeForQuote?.updatedAt ?? this.quote?.updatedAt ?? null;
  }

  get currentFresh(): boolean {
    return Boolean(this.feedFresh && this.quote?.fresh && this.currentUpdatedAt);
  }

  get bestBid(): number | null {
    const bids = this.activeForQuote?.book.bids ?? [];
    return bids.length ? Math.max(...bids.map((level) => level.price)) : null;
  }

  get bestAsk(): number | null {
    const asks = this.activeForQuote?.book.asks ?? [];
    return asks.length ? Math.min(...asks.map((level) => level.price)) : null;
  }

  get askLevels() {
    return [...(this.activeForQuote?.book.asks ?? [])].sort((first, second) => first.price - second.price).slice(0, 3);
  }

  get bidLevels() {
    return [...(this.activeForQuote?.book.bids ?? [])].sort((first, second) => second.price - first.price).slice(0, 3);
  }

  get spread(): number | null {
    return this.bestAsk !== null && this.bestBid !== null ? this.bestAsk - this.bestBid : null;
  }

  get spreadPercent(): number | null {
    return this.spread !== null && this.bestAsk ? this.spread / this.bestAsk * 100 : null;
  }

  get recentTrades() {
    return (this.activeForQuote?.trades ?? []).slice(0, 5);
  }

  get candlePath(): string {
    const candles = this.activeForQuote?.candles.slice(-70) ?? [];
    if (candles.length < 2) return '';
    const low = Math.min(...candles.map((candle) => candle.low));
    const high = Math.max(...candles.map((candle) => candle.high));
    const span = Math.max(high - low, high * 0.000001, Number.EPSILON);
    return candles.map((candle, index) => {
      const x = 4 + index / (candles.length - 1) * 592;
      const y = 84 - (candle.close - low) / span * 76;
      return `${index ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
  }

  close(): void {
    const dialog = this.marketDialog?.nativeElement;
    if (dialog?.open) dialog.close();
  }

  closeOnBackdrop(event: MouseEvent): void {
    if (event.target === event.currentTarget) this.close();
  }
}
