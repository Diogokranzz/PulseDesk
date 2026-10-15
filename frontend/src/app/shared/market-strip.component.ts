import { DatePipe } from '@angular/common';
import { Component, EventEmitter, Input, OnDestroy, OnInit, Output, signal } from '@angular/core';
import { MarketQuote } from '../core/market.types';
import { money, shortTime, signedPercent } from '../core/format';
import { CoinLogoComponent } from './coin-logo.component';

@Component({
  selector: 'pd-market-strip',
  standalone: true,
  imports: [DatePipe, CoinLogoComponent],
  templateUrl: './market-strip.component.html',
  styles: [':host{display:block}']
})
export class MarketStripComponent implements OnInit, OnDestroy {
  @Input({ required: true }) markets: MarketQuote[] = [];
  @Input() selectedSymbol = 'BTCUSD';
  @Input() feedFresh = false;
  @Output() marketSelected = new EventEmitter<string>();
  readonly now = signal(Date.now());
  private clockTimer: ReturnType<typeof setInterval> | null = null;

  money = money;
  signedPercent = signedPercent;
  shortTime = shortTime;

  ngOnInit(): void {
    this.clockTimer = setInterval(() => this.now.set(Date.now()), 1000);
  }

  ngOnDestroy(): void {
    if (this.clockTimer) clearInterval(this.clockTimer);
  }
}
