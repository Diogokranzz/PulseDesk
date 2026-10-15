import { Component, inject, signal } from '@angular/core';
import { MarketDataService } from '../../core/market-data.service';
import { ToastService } from '../../core/toast.service';
import { ActivityFeedComponent } from '../../shared/activity-feed.component';
import { OrdersTableComponent } from '../../shared/orders-table.component';
import { TradeJournalComponent } from '../../shared/trade-journal.component';

@Component({
  selector: 'pd-activity-page',
  standalone: true,
  imports: [ActivityFeedComponent, OrdersTableComponent, TradeJournalComponent],
  templateUrl: './activity-page.component.html',
  styles: [':host{display:block}']
})
export class ActivityPageComponent {
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
      this.notices.show('Não foi possível atualizar as ordens. A conta permaneceu sem alterações.', true);
    } finally {
      this.busy.set(false);
    }
  }
}
