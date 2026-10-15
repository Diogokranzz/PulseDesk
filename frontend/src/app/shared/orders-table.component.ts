import { Component, EventEmitter, Input, Output } from '@angular/core';
import { PaperOrder } from '../core/market.types';
import { dateTime, money, quantity } from '../core/format';

@Component({
  selector: 'pd-orders-table',
  standalone: true,
  templateUrl: './orders-table.component.html',
  styles: [':host{display:contents}']
})
export class OrdersTableComponent {
  @Input() orders: PaperOrder[] = [];
  @Input() showOpenOnly = false;
  @Input() allowCancel = true;
  @Input() pending = false;
  @Output() cancel = new EventEmitter<string>();

  dateTime = dateTime;
  money = money;
  quantity = quantity;

  get visibleOrders(): PaperOrder[] {
    const ordered = [...this.orders].sort((left, right) => right.createdAt - left.createdAt);
    return this.showOpenOnly ? ordered.filter((order) => order.status === 'open') : ordered;
  }

  statusLabel(order: PaperOrder): string {
    if (order.status === 'filled') return 'EXECUTADA';
    if (order.status === 'cancelled') return order.filledQuantity > 0 ? 'CANCELADA · PARCIAL' : 'CANCELADA';
    return order.filledQuantity > 0 ? `PARCIAL ${quantity(order.filledQuantity)} / ${quantity(order.quantity)}` : 'ABERTA';
  }
}
