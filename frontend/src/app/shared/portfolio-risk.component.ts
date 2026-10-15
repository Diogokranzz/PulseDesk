import { Component, Input } from '@angular/core';
import { AccountSnapshot, PerformancePoint, Position } from '../core/market.types';
import { money, signedPercent } from '../core/format';

@Component({
  selector: 'pd-portfolio-risk',
  standalone: true,
  templateUrl: './portfolio-risk.component.html',
  styles: [
    ':host{display:block;min-width:0}.riskGrid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:16px}.riskMetric{min-width:0;padding:16px;border:1px solid var(--line);border-radius:12px;background:rgba(255,255,255,.018)}.riskMetric span{display:block;color:var(--muted);font:600 10px/1.5 var(--mono);letter-spacing:.1em;text-transform:uppercase}.riskMetric strong{display:block;margin-top:8px;color:var(--text);font:600 19px/1.2 var(--mono)}.riskMetric small{display:block;margin-top:7px;color:var(--muted);font-size:12px;line-height:1.45}.riskDisclaimer{margin:16px 0 0;color:var(--muted);font-size:12px}@media(max-width:760px){.riskGrid{grid-template-columns:1fr}}'
  ]
})
export class PortfolioRiskComponent {
  @Input({ required: true }) account!: AccountSnapshot;
  @Input() positions: Position[] = [];
  @Input() performance: PerformancePoint[] = [];

  readonly money = money;
  readonly signedPercent = signedPercent;

  get mostConcentrated(): { symbol: string; percent: number } | null {
    if (!this.account.equity || this.account.equity <= 0) return null;
    const largest = this.positions.filter((position) => Number.isFinite(position.value)).sort((left, right) => (right.value ?? 0) - (left.value ?? 0))[0];
    return largest ? { symbol: largest.symbol.replace('USD', ''), percent: (largest.value ?? 0) / this.account.equity * 100 } : null;
  }

  get scenarioLoss(): number | null {
    if (!this.account.capitalConfigured || !this.account.valuationComplete || !Number.isFinite(this.account.equity)) return null;
    return this.positions.reduce((sum, position) => sum + (position.value ?? 0) * 0.1, 0);
  }

  get scenarioEquity(): number | null {
    return this.account.equity !== null && this.scenarioLoss !== null ? this.account.equity - this.scenarioLoss : null;
  }

  get maxDrawdown(): number | null {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const points = this.performance.filter((point) => point.time >= cutoff && point.value > 0);
    if (points.length < 2) return null;
    let peak = points[0].value;
    let drawdown = 0;
    for (const point of points) {
      peak = Math.max(peak, point.value);
      drawdown = Math.max(drawdown, (peak - point.value) / peak * 100);
    }
    return drawdown;
  }
}
