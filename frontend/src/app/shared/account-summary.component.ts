import { Component, Input } from '@angular/core';
import { AccountSnapshot, MarketQuote, PerformancePoint } from '../core/market.types';
import { money, shortTime, signedMoney, signedPercent } from '../core/format';

@Component({
  selector: 'pd-account-summary',
  standalone: true,
  templateUrl: './account-summary.component.html',
  styles: [':host{display:block}']
})
export class AccountSummaryComponent {
  @Input({ required: true }) account!: AccountSnapshot;
  @Input() markets: MarketQuote[] = [];
  @Input() performance: PerformancePoint[] = [];

  money = money;
  signedMoney = signedMoney;
  signedPercent = signedPercent;
  shortTime = shortTime;

  get risingCount(): number {
    return this.markets.filter((market) => market.fresh && market.change !== null && market.change > 0).length;
  }

  get freshMarketCount(): number {
    return this.markets.filter((market) => market.fresh).length;
  }

  get averageMovement(): number | null {
    const values = this.markets.filter((market) => market.fresh).map((market) => market.change).filter((change): change is number => change !== null);
    return values.length ? values.reduce((total, change) => total + Math.abs(change), 0) / values.length : null;
  }

  get cashPercent(): number {
    return this.account.valuationComplete && this.account.equity && this.account.buyingPower !== null
      ? Math.max(0, Math.min(this.account.buyingPower / this.account.equity * 100, 100))
      : 0;
  }

  barHeight(change: number | null): number {
    return change === null ? 4 : Math.max(5, Math.min(Math.abs(change) * 5 + 6, 18));
  }

  barColor(change: number | null): string {
    return change === null ? 'var(--line)' : change >= 0 ? 'var(--green)' : 'var(--red)';
  }

  get sparkline(): string {
    if (this.performance.length < 2) return '';
    const values = this.performance.map((point) => point.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = Math.max(max - min, 1);
    return values.map((value, index) => {
      const x = index / (values.length - 1) * 280;
      const y = 47 - (value - min) / span * 39;
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`;
    }).join(' ');
  }
}
