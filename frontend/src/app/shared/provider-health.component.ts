import { Component, Input } from '@angular/core';
import { FeedStatus, MarketSnapshot } from '../core/market.types';
import { shortTime } from '../core/format';

@Component({
  selector: 'pd-provider-health',
  standalone: true,
  templateUrl: './provider-health.component.html',
  styles: [':host{display:block;grid-column:span 12;min-width:0}.providerPanel{min-width:0;min-height:0}.providerRows{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:12px}.providerRow{min-width:0;display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:11px 12px;border:1px solid var(--line);border-radius:9px}.providerName{flex:0 0 auto;display:flex;align-items:center;gap:9px;color:var(--text);font-size:12px;font-weight:600}.providerName i{width:7px;height:7px;flex:0 0 7px;border-radius:50%;background:var(--red);box-shadow:0 0 9px currentColor}.providerName i.isFresh{background:var(--green)}.providerMeta{min-width:0;display:flex;flex-wrap:wrap;justify-content:flex-end;gap:4px 12px;color:var(--muted);font:500 10px/1.45 var(--mono);text-align:right;overflow-wrap:anywhere}.providerState{color:var(--amber)}.providerState.isFresh{color:var(--green)}@media(max-width:960px){.providerRows{grid-template-columns:1fr}.providerRow{align-items:flex-start}.providerMeta{justify-content:flex-start;text-align:left}}@media(max-width:520px){.providerRow{flex-direction:column}.providerMeta{display:grid;grid-template-columns:1fr;gap:4px}}']
})
export class ProviderHealthComponent {
  @Input({ required: true }) sources!: MarketSnapshot['feed']['sources'];
  @Input() sseConnections = 0;
  @Input() apiLive = false;
  readonly shortTime = shortTime;

  statusLabel(status: FeedStatus, freshAssets: number): string {
    if (status === 'online') return freshAssets > 0 ? 'AO VIVO' : 'CONECTADO · AGUARDANDO COTAÇÕES';
    if (status === 'connected') return 'CONECTADO · VALIDANDO FEED';
    if (status === 'connecting') return 'CONECTANDO';
    if (status === 'reconnecting') return 'RECONECTANDO';
    if (status === 'stale') return 'SEM COTAÇÃO RECENTE';
    return 'SEM CONEXÃO';
  }
}
