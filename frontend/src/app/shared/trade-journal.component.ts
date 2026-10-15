import { Component, Input } from '@angular/core';
import { PaperOrder } from '../core/market.types';
import { dateTime, money, quantity } from '../core/format';

interface StrategySummary {
  name: string;
  orders: number;
  executedOrders: number;
  volume: number;
  fees: number;
}

@Component({
  selector: 'pd-trade-journal',
  standalone: true,
  templateUrl: './trade-journal.component.html',
  styles: [':host{display:block}.journalPanel{margin-top:14px}.strategyGrid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:14px 0}.strategyCard{padding:13px;border:1px solid var(--line);border-radius:9px}.strategyCard strong,.strategyCard span{display:block}.strategyCard strong{color:var(--text);font-size:13px}.strategyCard span{margin-top:7px;color:var(--muted);font:500 10px var(--mono)}.journalList{display:grid;gap:8px}.journalEntry{padding:13px;border:1px solid var(--line);border-radius:9px}.journalEntry header{display:flex;align-items:center;justify-content:space-between;gap:12px}.journalEntry header strong{font-size:12px}.journalEntry header span,.journalEntry p{color:var(--muted);font-size:11px;line-height:1.5}.journalEntry p{margin:8px 0 0;white-space:pre-wrap;overflow-wrap:anywhere}.journalEmpty{padding:20px;text-align:center;color:var(--muted);font-size:12px}@media(max-width:700px){.strategyGrid{grid-template-columns:1fr}}']
})
export class TradeJournalComponent {
  @Input() orders: PaperOrder[] = [];

  readonly dateTime = dateTime;
  readonly money = money;
  readonly quantity = quantity;

  get strategySummaries(): StrategySummary[] {
    const summaries = new Map<string, StrategySummary>();
    for (const order of this.orders) {
      const name = order.strategy || 'discretionary';
      const summary = summaries.get(name) ?? { name, orders: 0, executedOrders: 0, volume: 0, fees: 0 };
      summary.orders += 1;
      summary.executedOrders += order.filledQuantity > 0 ? 1 : 0;
      summary.volume += order.filledNotional ?? (order.averageFillPrice ?? 0) * order.filledQuantity;
      summary.fees += order.fee ?? 0;
      summaries.set(name, summary);
    }
    return [...summaries.values()].sort((left, right) => right.volume - left.volume).slice(0, 6);
  }

  get journalEntries(): PaperOrder[] {
    return this.orders.filter((order) => order.filledQuantity > 0 || Boolean(order.thesis)).sort((left, right) => right.createdAt - left.createdAt).slice(0, 20);
  }
}
