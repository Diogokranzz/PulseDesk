import { Component, Input } from '@angular/core';
import { MarketQuote } from '../core/market.types';
import { shortTime, signedPercent } from '../core/format';
import { CoinLogoComponent } from './coin-logo.component';

@Component({
  selector: 'pd-market-signals',
  standalone: true,
  imports: [CoinLogoComponent],
  templateUrl: './market-signals.component.html',
  styles: [':host{display:contents}']
})
export class MarketSignalsComponent {
  @Input() markets: MarketQuote[] = [];
  @Input() feedFresh = false;

  signedPercent = signedPercent;
  shortTime = shortTime;

  get sortedMarkets(): MarketQuote[] {
    return [...this.markets].sort((left, right) => Math.abs(right.change ?? 0) - Math.abs(left.change ?? 0));
  }

  get risingCount(): number {
    return this.freshMarkets.filter((market) => (market.change ?? 0) > 0).length;
  }

  get freshMarkets(): MarketQuote[] {
    return this.markets.filter((market) => market.fresh);
  }

  get breadth(): number {
    return this.freshMarkets.length ? this.risingCount / this.freshMarkets.length : 0;
  }

  get breadthPercent(): number {
    return Math.max(4, Math.min(this.breadth * 100, 96));
  }

  label(market: MarketQuote): string {
    const change = market.change;
    if (change === null) return 'Variação indisponível';
    if (Math.abs(change) < 0.45) return 'Variação contida em 24h';
    if (change > 0) return 'Maior alta observada em 24h';
    return 'Maior queda observada em 24h';
  }

  stateLabel(): string {
    if (!this.freshMarkets.length) return 'SEM COTAÇÕES ATUAIS';
    if (this.breadth >= 0.65) return 'EM ALTA';
    if (this.breadth <= 0.35) return 'EM BAIXA';
    return 'MISTO';
  }
}
