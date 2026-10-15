import { Component, Input } from '@angular/core';
import { PerformancePoint } from '../core/market.types';
import { money, signedPercent } from '../core/format';

@Component({
  selector: 'pd-performance-chart',
  standalone: true,
  templateUrl: './performance-chart.component.html',
  styles: [':host{display:contents}']
})
export class PerformanceChartComponent {
  @Input() points: PerformancePoint[] = [];
  @Input() dailyReturn: number | null = null;
  @Input() capitalConfigured = false;

  money = money;
  signedPercent = signedPercent;

  get line(): string {
    if (this.points.length < 2) return '';
    const values = this.points.map((point) => point.value);
    const min = Math.min(...values);
    const span = Math.max(Math.max(...values) - min, 1);
    return values.map((point, index) => {
      const x = index / (values.length - 1) * 780 + 20;
      const y = 182 - (point - min) / span * 150;
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`;
    }).join(' ');
  }

  get area(): string {
    return this.line ? `${this.line} L 800 192 L 20 192 Z` : '';
  }

  get latestValue(): number | null {
    return this.points.at(-1)?.value ?? null;
  }
}
