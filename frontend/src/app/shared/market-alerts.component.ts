import { Component, Input, OnChanges, SimpleChanges, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AccountSnapshot, MarketQuote, PaperOrder } from '../core/market.types';
import { money } from '../core/format';
import { ToastService } from '../core/toast.service';

type AlertCondition = 'above' | 'below';
interface MarketAlert {
  id: string;
  symbol: string;
  condition: AlertCondition;
  target: number;
  createdAt: number;
  firedAt: number | null;
}

interface AlertPreferences {
  dailyLossLimit: number | null;
  tradeExecutions: boolean;
  staleFeed: boolean;
  lossFiredOn: string | null;
  lastFeedNoticeAt: number;
}

const storageKey = 'pulsedesk.market-alerts.v1';
const preferencesKey = 'pulsedesk.market-alert-preferences.v1';

function loadPreferences(): AlertPreferences {
  const defaults: AlertPreferences = { dailyLossLimit: null, tradeExecutions: true, staleFeed: true, lossFiredOn: null, lastFeedNoticeAt: 0 };
  if (typeof localStorage === 'undefined') return defaults;
  try {
    const value: unknown = JSON.parse(localStorage.getItem(preferencesKey) ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return defaults;
    const source = value as Record<string, unknown>;
    return {
      dailyLossLimit: typeof source['dailyLossLimit'] === 'number' && Number.isFinite(source['dailyLossLimit']) && source['dailyLossLimit'] > 0 ? source['dailyLossLimit'] : null,
      tradeExecutions: source['tradeExecutions'] !== false,
      staleFeed: source['staleFeed'] !== false,
      lossFiredOn: typeof source['lossFiredOn'] === 'string' ? source['lossFiredOn'] : null,
      lastFeedNoticeAt: typeof source['lastFeedNoticeAt'] === 'number' && Number.isFinite(source['lastFeedNoticeAt']) ? source['lastFeedNoticeAt'] : 0
    };
  } catch {
    return defaults;
  }
}

@Component({
  selector: 'pd-market-alerts',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './market-alerts.component.html',
  styles: [
    ':host{display:block;grid-column:1/-1;min-width:0}.alertsPanel{min-width:0}.alertForm{display:grid;grid-template-columns:minmax(100px,1fr) minmax(100px,1fr) minmax(120px,1fr) auto;gap:10px;margin:18px 0}.alertForm>*{min-width:0}.alertSettings{display:grid;grid-template-columns:minmax(140px,1.2fr) minmax(110px,.7fr) auto minmax(170px,1fr) minmax(170px,1fr);align-items:center;gap:10px;margin:12px 0 16px;padding:12px;border:1px solid var(--line);border-radius:9px}.alertSettingLabel{color:var(--muted);font:600 10px var(--mono);letter-spacing:.05em;text-transform:uppercase}.alertToggle{display:flex;align-items:center;gap:7px;color:var(--muted);font-size:11px}.alertToggle input{accent-color:var(--green)}.alertList{display:grid;gap:8px}.alertRow{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;border:1px solid var(--line);border-radius:9px;color:var(--muted);font-size:12px}.alertRow strong{color:var(--text)}.alertFired{color:var(--green)}.alertRemove{border:0;background:transparent;color:var(--muted);cursor:pointer;font:600 16px var(--mono)}.alertEmpty{padding:20px 8px;text-align:center;color:var(--muted);font-size:12px}@media(max-width:900px){.alertSettings{grid-template-columns:minmax(0,1.1fr) minmax(130px,.8fr) auto}.alertToggle{grid-column:auto}}@media(max-width:740px){.alertForm{grid-template-columns:1fr 1fr}.alertForm button{grid-column:1/-1}.alertSettings{grid-template-columns:1fr 1fr}.alertSettingLabel{grid-column:1/-1}}@media(max-width:480px){.alertSettings{grid-template-columns:1fr}.alertToggle{grid-column:1/-1}}'
  ]
})
export class MarketAlertsComponent implements OnChanges {
  @Input() markets: MarketQuote[] = [];
  @Input() account: AccountSnapshot | null = null;
  @Input() orders: PaperOrder[] = [];
  @Input() feedFresh = false;
  readonly alerts = signal<MarketAlert[]>(this.load());
  readonly preferences = signal<AlertPreferences>(loadPreferences());
  readonly selectedSymbol = signal('BTCUSD');
  readonly condition = signal<AlertCondition>('above');
  readonly target = signal<number | null>(null);
  readonly lossLimitDraft = signal<number | null>(this.preferences().dailyLossLimit);
  readonly money = money;
  private previousOrders = new Map<string, number>();
  private ordersInitialized = false;
  private previousFeedFresh: boolean | null = null;
  private lastTradeNoticeAt = 0;

  constructor(private readonly notices: ToastService) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['markets']) this.evaluatePrices();
    if (changes['orders']) this.evaluateExecutions();
    if (changes['feedFresh']) this.evaluateFeed();
    if (changes['account']) this.evaluateDailyLoss();
  }

  addAlert(): void {
    const target = this.target();
    if (!Number.isFinite(target) || target === null || target <= 0 || this.alerts().length >= 30) return;
    const alert: MarketAlert = { id: crypto.randomUUID(), symbol: this.selectedSymbol(), condition: this.condition(), target, createdAt: Date.now(), firedAt: null };
    this.alerts.update((alerts) => [alert, ...alerts]);
    this.target.set(null);
    this.persistAlerts();
  }

  remove(id: string): void {
    this.alerts.update((alerts) => alerts.filter((alert) => alert.id !== id));
    this.persistAlerts();
  }

  marketName(symbol: string): string {
    return this.markets.find((market) => market.symbol === symbol)?.short ?? symbol.replace('USD', '');
  }

  saveDailyLossLimit(): void {
    const limit = this.lossLimitDraft();
    if (!Number.isFinite(limit) || limit === null || limit <= 0) {
      this.notices.show('Informe um limite de perda válido em USD.', true);
      return;
    }
    this.updatePreferences({ ...this.preferences(), dailyLossLimit: limit, lossFiredOn: null });
    this.notices.show('Limite de perda em 24 horas salvo neste navegador.');
    this.evaluateDailyLoss();
  }

  clearDailyLossLimit(): void {
    this.lossLimitDraft.set(null);
    this.updatePreferences({ ...this.preferences(), dailyLossLimit: null, lossFiredOn: null });
  }

  setTradeNotifications(enabled: boolean): void {
    this.updatePreferences({ ...this.preferences(), tradeExecutions: enabled });
  }

  setFeedNotifications(enabled: boolean): void {
    this.updatePreferences({ ...this.preferences(), staleFeed: enabled });
  }

  private evaluatePrices(): void {
    let triggered = 0;
    this.alerts.update((alerts) => alerts.map((alert) => {
      if (alert.firedAt !== null) return alert;
      const market = this.markets.find((item) => item.symbol === alert.symbol);
      if (!market?.fresh || market.price === null) return alert;
      const crossed = alert.condition === 'above' ? market.price >= alert.target : market.price <= alert.target;
      if (!crossed) return alert;
      triggered += 1;
      return { ...alert, firedAt: Date.now() };
    }));
    if (!triggered) return;
    this.persistAlerts();
    this.notices.show(triggered === 1 ? 'Alerta de preço atingido.' : `${triggered} alertas de preço atingidos.`);
  }

  private evaluateDailyLoss(): void {
    const preferences = this.preferences();
    const account = this.account;
    if (!preferences.dailyLossLimit || !account?.dailyValuationComplete || account.dailyPnl === null || account.dailyPnl > -preferences.dailyLossLimit) return;
    const currentDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
    if (preferences.lossFiredOn === currentDay) return;
    this.updatePreferences({ ...preferences, lossFiredOn: currentDay });
    this.notices.show(`O limite de perda em 24 horas de ${this.money(preferences.dailyLossLimit)} foi atingido.`, true);
  }

  private evaluateExecutions(): void {
    const current = new Map(this.orders.map((order) => [order.id, order.filledQuantity]));
    if (!this.ordersInitialized) {
      this.previousOrders = current;
      this.ordersInitialized = true;
      return;
    }
    let changed = 0;
    for (const [id, filledQuantity] of current) {
      if (filledQuantity > (this.previousOrders.get(id) ?? 0) + 0.00000001) changed += 1;
    }
    this.previousOrders = current;
    if (!changed || !this.preferences().tradeExecutions) return;
    const now = Date.now();
    if (now - this.lastTradeNoticeAt < 5000) return;
    this.lastTradeNoticeAt = now;
    this.notices.show(changed === 1 ? 'Uma ordem paper teve uma execução nova.' : `${changed} ordens paper tiveram execuções novas.`);
  }

  private evaluateFeed(): void {
    const previous = this.previousFeedFresh;
    this.previousFeedFresh = this.feedFresh;
    if (previous !== true || this.feedFresh || !this.preferences().staleFeed) return;
    const preferences = this.preferences();
    const now = Date.now();
    if (now - preferences.lastFeedNoticeAt < 15 * 60 * 1000) return;
    this.updatePreferences({ ...preferences, lastFeedNoticeAt: now });
    this.notices.show('As cotações ficaram desatualizadas. A conta local permanece disponível.', true);
  }

  private updatePreferences(value: AlertPreferences): void {
    this.preferences.set(value);
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(preferencesKey, JSON.stringify(value));
    } catch {
      this.notices.show('Não foi possível salvar as preferências de alerta neste navegador.', true);
    }
  }

  private load(): MarketAlert[] {
    if (typeof localStorage === 'undefined') return [];
    try {
      const value: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
      if (!Array.isArray(value)) return [];
      return value.filter((item): item is MarketAlert => Boolean(
        item && typeof item === 'object' && typeof item.id === 'string' &&
        typeof item.symbol === 'string' && ['BTCUSD', 'ETHUSD', 'SOLUSD', 'XRPUSD', 'ADAUSD'].includes(item.symbol) &&
        (item.condition === 'above' || item.condition === 'below') && Number.isFinite(item.target) && item.target > 0 &&
        Number.isFinite(item.createdAt) && (item.firedAt === null || Number.isFinite(item.firedAt))
      )).slice(0, 30);
    } catch {
      return [];
    }
  }

  private persistAlerts(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(storageKey, JSON.stringify(this.alerts()));
    } catch {
      this.notices.show('Não foi possível salvar os alertas neste navegador.', true);
    }
  }
}
