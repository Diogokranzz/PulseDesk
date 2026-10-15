import { Component, Input } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MarketSnapshot } from '../core/market.types';
import { money, signedMoney, signedPercent, shortTime } from '../core/format';

type InsightQuestion = 'daily' | 'concentration' | 'scenario' | 'market';

@Component({
  selector: 'pd-portfolio-insights',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './portfolio-insights.component.html',
  styles: [':host{display:block}.insightsPanel{margin-top:16px}.insightPrompt{display:flex;align-items:center;gap:10px;margin:14px 0}.insightPrompt label{color:var(--muted);font:600 10px var(--mono);letter-spacing:.08em;text-transform:uppercase}.insightPrompt select{max-width:420px}.insightAnswer{padding:16px;border:1px solid var(--line);border-radius:10px;background:rgba(255,255,255,.018)}.insightAnswer strong{display:block;color:var(--text);font-size:13px}.insightAnswer p{margin:8px 0 0;color:var(--muted);font-size:12px;line-height:1.55}.insightFootnote{margin:12px 0 0;color:var(--muted);font-size:10px;line-height:1.5}@media(max-width:650px){.insightPrompt{align-items:stretch;flex-direction:column}.insightPrompt select{max-width:none}}']
})
export class PortfolioInsightsComponent {
  @Input({ required: true }) snapshot!: MarketSnapshot;

  question: InsightQuestion = 'daily';
  readonly money = money;
  readonly signedMoney = signedMoney;
  readonly signedPercent = signedPercent;
  readonly shortTime = shortTime;

  get answer(): { title: string; body: string; quality: string } {
    const { account, active, positions, network, feed } = this.snapshot;
    if (this.question === 'daily') {
      if (!account.dailyValuationComplete || account.dailyPnl === null || account.dailyReferenceAt === null) return {
        title: 'Resultado observado nas últimas 24 horas',
        body: 'Ainda não há uma janela contínua de 24 horas na série persistida. O resultado diário inclui a variação de patrimônio entre as amostras e aguarda histórico suficiente.',
        quality: 'SEM JANELA COMPLETA'
      };
      return {
        title: 'Variação de patrimônio nas últimas 24 horas',
        body: `${this.signedMoney(account.dailyPnl)} (${this.signedPercent(account.dailyPercent)}). A referência observada foi registrada às ${this.shortTime(account.dailyReferenceAt)} BRT. O cálculo inclui operações abertas e encerradas refletidas no patrimônio.`,
        quality: 'AMOSTRAS PERSISTIDAS'
      };
    }
    if (this.question === 'concentration') {
      const valuedPositions = positions.filter((position) => Number.isFinite(position.value)).sort((left, right) => (right.value ?? 0) - (left.value ?? 0));
      if (!account.capitalConfigured) return {
        title: 'Concentração da carteira',
        body: 'Adicione seu capital manualmente para começar a avaliar exposição financeira.',
        quality: 'CAPITAL NÃO CONFIGURADO'
      };
      if (!account.valuationComplete || !account.equity) return {
        title: 'Concentração da carteira',
        body: 'Aguarde cotações atuais para calcular a concentração por ativo.',
        quality: 'AVALIAÇÃO INCOMPLETA'
      };
      if (!valuedPositions.length) return {
        title: 'Concentração da carteira',
        body: 'Não há posições abertas. O patrimônio está mantido em caixa e não tem concentração em ativos digitais.',
        quality: '0 POSIÇÕES ABERTAS'
      };
      const breakdown = valuedPositions.map((position) => `${position.symbol.replace('USD', '')}: ${((position.value ?? 0) / account.equity! * 100).toFixed(2)}%`).join(' · ');
      const observedAt = Math.min(...valuedPositions.map((position) => this.snapshot.markets.find((market) => market.symbol === position.symbol)?.updatedAt ?? Date.now()));
      return {
        title: 'Distribuição do patrimônio por ativo',
        body: `${breakdown}. A maior posição está marcada em ${this.money(valuedPositions[0].value)}.`,
        quality: `${valuedPositions.length} POSIÇÕES AVALIADAS · COTAÇÕES DESDE ${this.shortTime(observedAt)} BRT`
      };
    }
    if (this.question === 'scenario') {
      if (!account.valuationComplete || account.equity === null) return {
        title: 'Cenário de queda de 10%',
        body: 'Configure capital e aguarde uma avaliação completa para estimar o efeito hipotético nas posições abertas.',
        quality: 'AVALIAÇÃO INCOMPLETA'
      };
      const loss = positions.reduce((sum, position) => sum + (position.value ?? 0) * 0.1, 0);
      const observedAt = positions.length ? Math.min(...positions.map((position) => this.snapshot.markets.find((market) => market.symbol === position.symbol)?.updatedAt ?? Date.now())) : this.snapshot.updatedAt;
      return {
        title: 'Cenário uniforme hipotético',
        body: `Se todas as posições abertas caíssem 10% ao mesmo tempo, a perda estimada seria ${this.money(loss)} e o patrimônio ficaria em ${this.money(account.equity - loss)}. Caixa não é afetado neste cenário.`,
        quality: `SIMULAÇÃO, NÃO PREVISÃO · COTAÇÕES DESDE ${this.shortTime(observedAt)} BRT`
      };
    }
    const bestBid = active.book.bids[0]?.price;
    const bestAsk = active.book.asks[0]?.price;
    const spread = active.book.fresh && Number.isFinite(bestBid) && Number.isFinite(bestAsk) && bestBid > 0 && bestAsk >= bestBid ? (bestAsk - bestBid) / ((bestAsk + bestBid) / 2) * 100 : null;
    const regime = network.intelligence.assets.find((asset) => asset.symbol === active.symbol);
    const regimeLabel = regime?.regime === 'bullish' ? 'positivo' : regime?.regime === 'bearish' ? 'negativo' : 'neutro';
    const volume = active.volume === null ? 'indisponível' : `${active.volume.toLocaleString('pt-BR', { maximumFractionDigits: 4 })} ${active.short}`;
    const quoteLine = active.price === null ? 'A cotação atual está indisponível.' : `A cotação de ${active.short} está em ${this.money(active.price)} com volume de 24 horas ${volume}.`;
    return {
      title: `Leitura de ${active.short}/USD`,
      body: `${quoteLine} Spread relativo ${spread === null ? 'indisponível' : spread.toFixed(4) + '%'}. O modelo local classifica o regime observado como ${regimeLabel}${regime?.confidence === null || regime?.confidence === undefined ? '' : `, com separação relativa de ${(regime.confidence * 100).toFixed(0)}% entre agrupamentos`}.`,
      quality: `${feed.provider.toUpperCase()} · ${feed.quoteFresh && active.updatedAt ? this.shortTime(active.updatedAt) + ' BRT' : 'COTAÇÃO DESATUALIZADA'}`
    };
  }
}
