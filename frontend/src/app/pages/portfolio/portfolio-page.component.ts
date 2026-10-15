import { Component, inject, signal } from '@angular/core';
import { MarketDataService } from '../../core/market-data.service';
import { ToastService } from '../../core/toast.service';
import { AccountSummaryComponent } from '../../shared/account-summary.component';
import { OrdersTableComponent } from '../../shared/orders-table.component';
import { PerformanceChartComponent } from '../../shared/performance-chart.component';
import { PositionsTableComponent } from '../../shared/positions-table.component';
import { PortfolioRiskComponent } from '../../shared/portfolio-risk.component';
import { BacktestComponent } from '../../shared/backtest.component';
import { PortfolioInsightsComponent } from '../../shared/portfolio-insights.component';

@Component({
  selector: 'pd-portfolio-page',
  standalone: true,
  imports: [AccountSummaryComponent, BacktestComponent, OrdersTableComponent, PerformanceChartComponent, PortfolioInsightsComponent, PositionsTableComponent, PortfolioRiskComponent],
  templateUrl: './portfolio-page.component.html',
  styles: [':host{display:block}']
})
export class PortfolioPageComponent {
  readonly data = inject(MarketDataService);
  private readonly notices = inject(ToastService);
  readonly busy = signal(false);

  async cancelOrder(id: string): Promise<void> {
    this.busy.set(true);
    try {
      if (id === '*') await this.data.cancelOpenOrders();
      else await this.data.cancelOrder(id);
      this.notices.show('Ordens atualizadas.');
    } catch {
      this.notices.show('Não foi possível atualizar as ordens. A carteira permaneceu sem alterações.', true);
    } finally {
      this.busy.set(false);
    }
  }
}
