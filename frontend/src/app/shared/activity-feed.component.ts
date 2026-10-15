import { Component, Input } from '@angular/core';
import { Fill, MarketTrade, MarketSnapshot } from '../core/market.types';
import { dateTime, money, quantity, shortTime } from '../core/format';

@Component({
  selector: 'pd-activity-feed',
  standalone: true,
  templateUrl: './activity-feed.component.html',
  styles: [':host{display:block}']
})
export class ActivityFeedComponent {
  @Input({ required: true }) snapshot!: MarketSnapshot;

  dateTime = dateTime;
  money = money;
  quantity = quantity;
  shortTime = shortTime;

  get recentFills(): Fill[] {
    return [...this.snapshot.fills].sort((left, right) => right.time - left.time);
  }

  get publicTrades(): MarketTrade[] {
    return [...this.snapshot.active.trades].sort((left, right) => right.time - left.time);
  }
}
