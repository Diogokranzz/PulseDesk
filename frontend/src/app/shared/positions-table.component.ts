import { Component, Input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MarketQuote, Position } from '../core/market.types';
import { money, quantity, signedMoney } from '../core/format';

@Component({
  selector: 'pd-positions-table',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './positions-table.component.html',
  styles: [':host{display:contents}']
})
export class PositionsTableComponent {
  @Input() positions: Position[] = [];
  @Input() markets: MarketQuote[] = [];
  @Input() capitalConfigured = false;
  @Input() totalValue: number | null = null;
  @Input() showPortfolioLink = true;

  money = money;
  quantity = quantity;
  signedMoney = signedMoney;

  market(symbol: string): MarketQuote | undefined {
    return this.markets.find((entry) => entry.symbol === symbol);
  }
}
