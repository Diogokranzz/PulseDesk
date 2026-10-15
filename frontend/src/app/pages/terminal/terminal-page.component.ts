import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { MarketDataService } from '../../core/market-data.service';
import { ActiveMarket, MarketQuote } from '../../core/market.types';
import { ToastService } from '../../core/toast.service';
import { AccountSummaryComponent } from '../../shared/account-summary.component';
import { MarketFlowComponent } from '../../shared/market-flow.component';
import { MarketSignalsComponent } from '../../shared/market-signals.component';
import { MarketStripComponent } from '../../shared/market-strip.component';
import { OrderBookComponent } from '../../shared/order-book.component';
import { OrdersTableComponent } from '../../shared/orders-table.component';
import { PerformanceChartComponent } from '../../shared/performance-chart.component';
import { PositionsTableComponent } from '../../shared/positions-table.component';
import { PriceChartComponent } from '../../shared/price-chart.component';
import { MarketDetailsDialogComponent } from '../../shared/market-details-dialog.component';
import { MarketAlertsComponent } from '../../shared/market-alerts.component';
import { ProviderHealthComponent } from '../../shared/provider-health.component';
import { money, quantity, shortTime } from '../../core/format';

@Component({
  selector: 'pd-terminal-page',
  standalone: true,
  imports: [AccountSummaryComponent, MarketAlertsComponent, MarketDetailsDialogComponent, MarketFlowComponent, MarketSignalsComponent, MarketStripComponent, OrderBookComponent, OrdersTableComponent, PerformanceChartComponent, PositionsTableComponent, PriceChartComponent, ProviderHealthComponent],
  templateUrl: './terminal-page.component.html',
  styles: [':host{display:block}']
})
export class TerminalPageComponent implements OnInit, OnDestroy {
  readonly data = inject(MarketDataService);
  private readonly notices = inject(ToastService);
  readonly interval = signal('1m');
  readonly busy = signal(false);
  readonly marketDetailsSymbol = signal<string | null>(null);
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  money = money;
  quantity = quantity;
  shortTime = shortTime;

  openMarketDetails(symbol: string): void {
    this.data.selectMarket(symbol);
    this.marketDetailsSymbol.set(symbol);
  }

  closeMarketDetails(): void {
    this.marketDetailsSymbol.set(null);
  }

  marketDetailsQuote(): MarketQuote | null {
    const symbol = this.marketDetailsSymbol();
    const snapshot = this.data.snapshot();
    if (!symbol || !snapshot) return null;
    return snapshot.markets.find((market) => market.symbol === symbol)
      ?? (snapshot.active.symbol === symbol ? snapshot.active : null);
  }

  marketDetailsActive(): ActiveMarket | null {
    const symbol = this.marketDetailsSymbol();
    const active = this.data.snapshot()?.active;
    return active?.symbol === symbol ? active : null;
  }

  ngOnInit(): void {
    this.refreshTimer = setInterval(() => void this.data.refresh(), 30_000);
  }

  ngOnDestroy(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
  }

  async refresh(): Promise<void> {
    this.busy.set(true);
    const success = await this.data.refresh();
    this.busy.set(false);
    if (!success) this.notices.show('A API não respondeu; os últimos dados continuam disponíveis.', true);
  }

  async cancelOrder(id: string): Promise<void> {
    this.busy.set(true);
    try {
      if (id === '*') {
        await this.data.cancelOpenOrders();
        this.notices.show('Ordens abertas canceladas.');
      } else {
        await this.data.cancelOrder(id);
        this.notices.show('Ordem cancelada.');
      }
    } catch {
      this.notices.show('Não foi possível atualizar as ordens. A conta permaneceu sem alterações.', true);
    } finally {
      this.busy.set(false);
    }
  }
}
