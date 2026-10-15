import { Component, Input } from '@angular/core';
import { ActiveMarket, BookLevel } from '../core/market.types';
import { money, quantity, shortTime } from '../core/format';

interface BookRowView extends BookLevel {
  cumulative: number;
  width: number;
}

@Component({
  selector: 'pd-order-book',
  standalone: true,
  templateUrl: './order-book.component.html',
  styles: [':host{display:contents}']
})
export class OrderBookComponent {
  @Input({ required: true }) active!: ActiveMarket;
  @Input() feedFresh = false;

  money = money;
  quantity = quantity;
  shortTime = shortTime;

  get askRows(): BookRowView[] {
    return this.rows(this.active?.book.asks ?? [], true);
  }

  get bidRows(): BookRowView[] {
    return this.rows(this.active?.book.bids ?? [], false);
  }

  get bookReady(): boolean {
    return Boolean(this.active?.book.ready && this.active.book.asks.length && this.active.book.bids.length);
  }

  get spread(): number | null {
    const ask = this.active?.book.asks[0]?.price;
    const bid = this.active?.book.bids[0]?.price;
    return Number.isFinite(ask) && Number.isFinite(bid) ? (ask as number) - (bid as number) : null;
  }

  get midpoint(): number | null {
    const ask = this.active?.book.asks[0]?.price;
    const bid = this.active?.book.bids[0]?.price;
    return Number.isFinite(ask) && Number.isFinite(bid) ? ((ask as number) + (bid as number)) / 2 : null;
  }

  get bidShare(): number | null {
    const bid = this.active?.book.bids.reduce((sum, level) => sum + level.quantity, 0) ?? 0;
    const ask = this.active?.book.asks.reduce((sum, level) => sum + level.quantity, 0) ?? 0;
    return bid + ask ? Math.round(bid / (bid + ask) * 100) : null;
  }

  private rows(levels: BookLevel[], reverse: boolean): BookRowView[] {
    const visible = reverse ? [...levels].reverse() : levels;
    const maximum = Math.max(...visible.map((level) => level.quantity), 1);
    let cumulative = 0;
    return visible.map((level) => {
      cumulative += level.quantity;
      return { ...level, cumulative, width: Math.min(level.quantity / maximum * 100, 100) };
    });
  }
}
