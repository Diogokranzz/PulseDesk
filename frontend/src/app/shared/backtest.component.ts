import { Component, Input } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActiveMarket } from '../core/market.types';
import { money, signedPercent } from '../core/format';

interface BacktestResult {
  candles: number;
  trades: number;
  wins: number;
  fees: number;
  endingEquity: number;
  totalReturn: number;
  buyAndHoldReturn: number;
  maxDrawdown: number;
}

@Component({
  selector: 'pd-backtest',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './backtest.component.html',
  styles: [':host{display:block}.backtestPanel{margin-top:16px}.backtestControls{display:grid;grid-template-columns:repeat(3,minmax(120px,1fr));gap:10px;margin:16px 0}.backtestControls label{display:grid;gap:6px;color:var(--muted);font:600 10px var(--mono);letter-spacing:.06em;text-transform:uppercase}.backtestControls input{min-width:0}.backtestMetrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.backtestMetric{padding:13px;border:1px solid var(--line);border-radius:9px}.backtestMetric span,.backtestMetric strong{display:block}.backtestMetric span{color:var(--muted);font:500 10px var(--mono);text-transform:uppercase}.backtestMetric strong{margin-top:8px;color:var(--text);font:600 16px var(--mono)}.backtestNote{color:var(--muted);font-size:11px;line-height:1.5}.backtestEmpty{padding:18px;text-align:center;color:var(--muted);font-size:12px}@media(max-width:760px){.backtestControls{grid-template-columns:1fr}.backtestMetrics{grid-template-columns:repeat(2,minmax(0,1fr))}}']
})
export class BacktestComponent {
  @Input({ required: true }) active!: ActiveMarket;

  fastPeriod = 8;
  slowPeriod = 21;
  slippageBps = 5;
  readonly money = money;
  readonly signedPercent = signedPercent;

  get result(): BacktestResult | null {
    const fast = Math.round(Number(this.fastPeriod));
    const slow = Math.round(Number(this.slowPeriod));
    const slippage = Number(this.slippageBps);
    const now = Date.now();
    const candles = (this.active?.candles ?? []).filter((candle) => Number.isFinite(candle.time) && candle.time > 0 && candle.time + 60000 <= now && Number.isFinite(candle.open) && candle.open > 0 && Number.isFinite(candle.close) && candle.close > 0).sort((left, right) => left.time - right.time);
    if (!Number.isInteger(fast) || !Number.isInteger(slow) || fast < 2 || slow <= fast || slow > 100 || !Number.isFinite(slippage) || slippage < 0 || slippage > 500 || candles.length < slow + 3) return null;

    const startingEquity = 10000;
    const feeRate = 0.001;
    const slippageRate = slippage / 10000;
    let cash = startingEquity;
    let quantity = 0;
    let entryCost = 0;
    let fees = 0;
    let completedTrades = 0;
    let wins = 0;
    let peak = startingEquity;
    let maxDrawdown = 0;
    const meanClose = (end: number, length: number): number => {
      let sum = 0;
      for (let index = end - length + 1; index <= end; index += 1) sum += candles[index].close;
      return sum / length;
    };

    for (let index = slow; index < candles.length - 1; index += 1) {
      const fastPrevious = meanClose(index - 1, fast);
      const slowPrevious = meanClose(index - 1, slow);
      const fastCurrent = meanClose(index, fast);
      const slowCurrent = meanClose(index, slow);
      const nextOpen = candles[index + 1].open;
      if (quantity === 0 && fastPrevious <= slowPrevious && fastCurrent > slowCurrent) {
        const entryPrice = nextOpen * (1 + slippageRate);
        quantity = cash / (entryPrice * (1 + feeRate));
        const entryNotional = quantity * entryPrice;
        const fee = entryNotional * feeRate;
        entryCost = entryNotional + fee;
        cash -= entryNotional + fee;
        fees += fee;
      } else if (quantity > 0 && fastPrevious >= slowPrevious && fastCurrent < slowCurrent) {
        const exitPrice = nextOpen * (1 - slippageRate);
        const exitNotional = quantity * exitPrice;
        const fee = exitNotional * feeRate;
        const proceeds = exitNotional - fee;
        if (proceeds > entryCost) wins += 1;
        cash += proceeds;
        fees += fee;
        quantity = 0;
        entryCost = 0;
        completedTrades += 1;
      }
      const equity = cash + quantity * candles[index + 1].close;
      peak = Math.max(peak, equity);
      maxDrawdown = Math.max(maxDrawdown, peak > 0 ? (peak - equity) / peak * 100 : 0);
    }

    if (quantity > 0) {
      const exitPrice = candles.at(-1)!.close * (1 - slippageRate);
      const exitNotional = quantity * exitPrice;
      const fee = exitNotional * feeRate;
      const proceeds = exitNotional - fee;
      if (proceeds > entryCost) wins += 1;
      cash += proceeds;
      fees += fee;
      completedTrades += 1;
      peak = Math.max(peak, cash);
      maxDrawdown = Math.max(maxDrawdown, peak > 0 ? (peak - cash) / peak * 100 : 0);
    }
    const firstPrice = candles[slow - 1].close;
    const lastPrice = candles.at(-1)!.close;
    const buyAndHoldEnd = startingEquity * (lastPrice * (1 - slippageRate) * (1 - feeRate)) / (firstPrice * (1 + slippageRate) * (1 + feeRate));
    return {
      candles: candles.length,
      trades: completedTrades,
      wins,
      fees,
      endingEquity: cash,
      totalReturn: (cash / startingEquity - 1) * 100,
      buyAndHoldReturn: (buyAndHoldEnd / startingEquity - 1) * 100,
      maxDrawdown
    };
  }
}
