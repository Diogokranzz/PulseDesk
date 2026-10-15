import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { MarketDataService } from './core/market-data.service';
import { ToastService } from './core/toast.service';
import { money, quantity, signedMoney, signedPercent } from './core/format';
import { BookLevel, NewOrder, OrderSide, OrderType, PulseDeskBackup, SimulationBackup } from './core/market.types';
import { CoinLogoComponent } from './shared/coin-logo.component';

@Component({
  selector: 'pd-root',
  standalone: true,
  imports: [DatePipe, FormsModule, CoinLogoComponent, RouterLink, RouterLinkActive, RouterOutlet],
  templateUrl: './app.component.html'
})
export class AppComponent implements OnInit {
  readonly marketData = inject(MarketDataService);
  readonly notices = inject(ToastService);
  readonly pending = signal(false);
  readonly side = signal<OrderSide>('buy');
  readonly orderType = signal<OrderType>('market');
  readonly orderSymbol = signal('BTCUSD');
  readonly orderQuantity = signal<number | null>(null);
  readonly limitPrice = signal<number | null>(null);
  readonly orderStrategy = signal('discretionary');
  readonly orderThesis = signal('');
  readonly capitalAmount = signal<number | null>(null);
  readonly maxCapital = 1_000_000_000;
  readonly capitalValidationMessage = computed(() => {
    const amount = this.capitalAmount();
    if (amount === null) return '';
    if (!Number.isFinite(amount) || amount < 0.01) return 'O capital mínimo é US$ 0,01.';
    if (amount > this.maxCapital) return `O limite de capital é ${money(this.maxCapital)}.`;
    return '';
  });
  readonly canSaveCapital = computed(() => {
    const amount = this.capitalAmount();
    return !this.pending() && amount !== null && Number.isFinite(amount) && amount >= 0.01 && amount <= this.maxCapital;
  });
  readonly resetPhrase = signal('');
  readonly backupRestorePhrase = signal('');
  readonly pendingBackup = signal<PulseDeskBackup | null>(null);
  readonly profileName = signal('Minha conta');
  readonly profileNameDraft = signal('Minha conta');
  readonly profileAvatar = signal<string | null>(null);
  readonly profileAvatarDraft = signal<string | null>(null);
  readonly profileInitials = computed(() => {
    return this.makeInitials(this.profileName());
  });
  readonly profileDraftInitials = computed(() => this.makeInitials(this.profileNameDraft()));

  readonly currentMarket = computed(() => {
    const snapshot = this.marketData.snapshot();
    const symbol = this.orderSymbol();
    return snapshot?.markets.find((market) => market.symbol === symbol) ?? snapshot?.active ?? null;
  });
  readonly canSubmitOrder = computed(() => {
    const snapshot = this.marketData.snapshot();
    const account = snapshot?.account;
    return Boolean(account?.capitalConfigured && this.marketData.marketIsLive() && snapshot?.feed.provider === 'Coinbase Advanced Trade' && !this.pending());
  });
  readonly availableAmount = computed(() => {
    const snapshot = this.marketData.snapshot();
    if (!snapshot) return null;
    if (this.side() === 'buy') return snapshot.account.buyingPower;
    return snapshot.positions.find((position) => position.symbol === this.orderSymbol())?.availableQuantity ?? 0;
  });
  readonly maxOrderQuantity = computed(() => {
    const available = this.availableAmount();
    if (!Number.isFinite(available) || available === null || available <= 0) return 0;
    const snapshot = this.marketData.snapshot();
    if (this.side() === 'sell') {
      if (this.orderType() === 'limit') return available;
      const active = snapshot?.active;
      if (!active || active.symbol !== this.orderSymbol() || !active.book.fresh) return 0;
      return Math.min(available, active.book.bids.reduce((sum, level) => sum + level.quantity, 0));
    }
    if (this.orderType() === 'limit') {
      const price = this.limitPrice();
      return Number.isFinite(price) && price !== null && price > 0 ? available / (price * 1.001) : 0;
    }
    const active = snapshot?.active;
    if (!active || active.symbol !== this.orderSymbol() || !active.book.fresh) return 0;
    return this.maxBuyQuantityForBudget(active.book.asks, available);
  });
  readonly estimatedMarketExecution = computed(() => {
    const amount = this.orderQuantity();
    const snapshot = this.marketData.snapshot();
    const active = snapshot?.active;
    if (!Number.isFinite(amount) || !active || active.symbol !== this.orderSymbol() || snapshot?.feed.provider !== 'Coinbase Advanced Trade' || !active.book.fresh || amount === null || amount <= 0) return null;
    const levels = this.side() === 'buy' ? active.book.asks : active.book.bids;
    let remaining = amount;
    let notional = 0;
    let spent = 0;
    let filledQuantity = 0;
    const budget = this.availableAmount() ?? 0;
    for (const level of levels) {
      let filled = Math.min(remaining, level.quantity);
      if (this.side() === 'buy') filled = Math.min(filled, Math.max(0, budget - spent) / (level.price * 1.001));
      if (filled <= 0) break;
      const levelNotional = filled * level.price;
      notional += levelNotional;
      spent += levelNotional * (this.side() === 'buy' ? 1.001 : 1);
      filledQuantity += filled;
      remaining -= filled;
      if (remaining <= 0.00000001) break;
    }
    if (filledQuantity <= 0) return null;
    return { notional, averagePrice: notional / filledQuantity, filledQuantity, remainingQuantity: Math.max(0, remaining), complete: remaining <= 0.00000001 };
  });
  readonly orderValidationMessage = computed(() => {
    const snapshot = this.marketData.snapshot();
    if (!snapshot?.account.capitalConfigured) return 'Configure o capital da conta antes de enviar uma ordem.';
    if (!this.marketData.marketIsLive()) return 'Aguarde uma cotação atual para validar a ordem.';
    if (snapshot.feed.provider !== 'Coinbase Advanced Trade') return 'O livro Coinbase precisa estar disponível para simular a ordem.';
    const amount = this.orderQuantity();
    const unit = this.currentMarket()?.short ?? 'ativo';
    if (!Number.isFinite(amount) || amount === null || amount <= 0) return `Informe a quantidade em ${unit}; o campo não recebe valor em dólares.`;
    if (amount > 1_000_000) return 'A quantidade máxima permitida por ordem é 1.000.000 unidades.';
    if (this.orderType() === 'limit' && (!Number.isFinite(this.limitPrice()) || (this.limitPrice() ?? 0) <= 0)) return 'Informe um preço limite válido para calcular o valor reservado.';

    const available = this.availableAmount() ?? 0;
    if (this.side() === 'sell' && this.orderType() === 'limit' && amount > available + 1e-8) return `Você tem ${quantity(available)} ${unit} disponíveis para vender.`;
    if (this.orderType() === 'market') {
      const active = snapshot.active;
      if (!active || active.symbol !== this.orderSymbol() || !active.book.fresh) return 'O livro de ofertas está desatualizado. Aguarde a atualização para estimar a ordem.';
      const levels = this.side() === 'buy' ? active.book.asks : active.book.bids;
      const bookQuantity = levels.reduce((sum, level) => sum + level.quantity, 0);
      const maximum = this.maxOrderQuantity();
      if (amount > maximum + 1e-8) {
        if (this.side() === 'buy' && maximum < bookQuantity - 1e-8) return `Saldo insuficiente para ${quantity(amount)} ${unit}, incluindo a taxa de 0,10%. Com o saldo disponível, o máximo estimado é ${quantity(maximum)} ${unit}.`;
        if (this.side() === 'sell' && amount > available + 1e-8) return `Você tem ${quantity(available)} ${unit} disponíveis para vender.`;
        return `Profundidade insuficiente no livro para ${quantity(amount)} ${unit}. O máximo estimado agora é ${quantity(maximum)} ${unit}; reduza a quantidade ou use uma ordem limitada.`;
      }
    } else if (this.side() === 'buy' && amount > this.maxOrderQuantity() + 1e-8) {
      return `Saldo insuficiente, incluindo a taxa de 0,10%. Com este preço limite, o máximo é ${quantity(this.maxOrderQuantity())} ${unit}.`;
    } else if (this.side() === 'sell' && amount > available + 1e-8) {
      return `Você tem ${quantity(available)} ${unit} disponíveis para vender.`;
    }
    return '';
  });
  readonly canPlaceOrder = computed(() => this.canSubmitOrder() && !this.orderValidationMessage());
  readonly canAllocateQuantity = computed(() => this.maxOrderQuantity() > 0 && !this.pending());
  readonly estimatedNotional = computed(() => {
    const amount = this.orderQuantity();
    if (!Number.isFinite(amount) || amount === null || amount <= 0) return null;
    if (this.orderType() === 'limit') {
      const price = this.limitPrice();
      return Number.isFinite(price) && price !== null && price > 0 ? price * amount : null;
    }
    return this.estimatedMarketExecution()?.notional ?? null;
  });
  readonly estimatedAveragePrice = computed(() => this.orderType() === 'limit' ? this.limitPrice() : this.estimatedMarketExecution()?.averagePrice ?? null);
  readonly estimatedFee = computed(() => {
    const notional = this.estimatedNotional();
    return notional === null ? null : notional * 0.001;
  });
  readonly estimatedTotal = computed(() => {
    const notional = this.estimatedNotional();
    if (notional === null) return null;
    return this.side() === 'buy' ? notional * 1.001 : notional * 0.999;
  });
  readonly liveLabel = computed(() => {
    if (!this.marketData.marketIsLive()) return this.marketData.snapshot() ? 'DADOS DESATUALIZADOS' : 'AGUARDANDO FEED';
    return this.marketData.snapshot()?.feed.provider === 'Kraken' ? 'AO VIVO · KRAKEN' : 'AO VIVO';
  });
  readonly visibleMarkets = computed(() => this.marketData.snapshot()?.markets ?? []);

  ngOnInit(): void {
    this.loadProfile();
    this.marketData.start();
  }

  money = money;
  quantity = quantity;
  signedMoney = signedMoney;
  signedPercent = signedPercent;

  selectMarket(symbol: string): void {
    this.marketData.selectMarket(symbol);
    this.orderSymbol.set(symbol);
  }

  selectOrderSymbol(symbol: string): void {
    this.orderSymbol.set(symbol);
    this.marketData.selectMarket(symbol);
  }

  openOrder(side: OrderSide = 'buy'): void {
    this.side.set(side);
    this.orderSymbol.set(this.marketData.selectedSymbol());
    const dialog = document.querySelector<HTMLDialogElement>('#orderDialog');
    if (dialog && !dialog.open) dialog.showModal();
  }

  openDialog(dialog: HTMLDialogElement): void {
    if (!dialog.open) dialog.showModal();
  }

  openProfile(dialog: HTMLDialogElement): void {
    this.profileNameDraft.set(this.profileName());
    this.profileAvatarDraft.set(this.profileAvatar());
    this.openDialog(dialog);
  }

  saveProfile(dialog: HTMLDialogElement): void {
    const name = this.profileNameDraft().trim().replace(/\s+/g, ' ');
    if (name.length < 2 || name.length > 40) {
      this.notices.show('O nome do perfil deve ter de 2 a 40 caracteres.', true);
      return;
    }
    try {
      localStorage.setItem('pulsedesk.profile.v1', JSON.stringify({ name, avatar: this.profileAvatarDraft() }));
      this.profileName.set(name);
      this.profileAvatar.set(this.profileAvatarDraft());
      dialog.close();
      this.notices.show('Perfil salvo neste navegador.');
    } catch {
      this.notices.show('O navegador não conseguiu salvar o perfil. Libere espaço no armazenamento local e tente novamente.', true);
    }
  }

  selectProfileAvatar(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      this.notices.show('Escolha uma imagem PNG, JPG ou WEBP.', true);
      return;
    }
    if (file.size > 512 * 1024) {
      this.notices.show('A imagem do perfil deve ter no máximo 512 KB.', true);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string' || !reader.result.startsWith(`data:${file.type};base64,`)) {
        this.notices.show('Não foi possível ler essa imagem.', true);
        return;
      }
      this.profileAvatarDraft.set(reader.result);
    };
    reader.onerror = () => this.notices.show('Não foi possível ler essa imagem.', true);
    reader.readAsDataURL(file);
  }

  removeProfileAvatar(): void {
    this.profileAvatarDraft.set(null);
  }

  closeDialog(dialog: HTMLDialogElement): void {
    dialog.close();
  }

  cancelBackupRestore(dialog: HTMLDialogElement): void {
    dialog.close();
    this.pendingBackup.set(null);
    this.backupRestorePhrase.set('');
  }

  async refresh(): Promise<void> {
    this.pending.set(true);
    const refreshed = await this.marketData.refresh();
    this.pending.set(false);
    this.notices.show(refreshed ? 'Painel atualizado' : 'Sem novos dados de mercado. Aguardando a conexão voltar.', !refreshed);
  }

  allocate(fraction: number): void {
    const maxQuantity = this.maxOrderQuantity();
    if (!Number.isFinite(maxQuantity) || maxQuantity <= 0) return;
    this.orderQuantity.set(maxQuantity * fraction);
  }

  async submitOrder(): Promise<void> {
    const quantityValue = this.orderQuantity();
    const limit = this.orderType() === 'limit' ? this.limitPrice() : null;
    if (!this.canSubmitOrder() || !Number.isFinite(quantityValue) || (quantityValue as number) <= 0) {
      this.notices.show('Aguarde cotações ao vivo e informe uma quantidade válida.', true);
      return;
    }
    if (this.orderType() === 'limit' && (!Number.isFinite(limit) || (limit as number) <= 0)) {
      this.notices.show('Informe um preço limite válido.', true);
      return;
    }
    const payload: NewOrder = {
      symbol: this.orderSymbol(),
      side: this.side(),
      type: this.orderType(),
      quantity: quantityValue as number,
      limitPrice: limit,
      strategy: this.orderStrategy(),
      thesis: this.orderThesis().trim(),
      idempotencyKey: crypto.randomUUID()
    };
    this.pending.set(true);
    try {
      await this.marketData.submitOrder(payload);
      this.closeDialogById('orderDialog');
      this.orderQuantity.set(null);
      this.limitPrice.set(null);
      this.orderThesis.set('');
      this.notices.show('Ordem simulada registrada.');
    } catch (error) {
      this.notices.show(this.errorMessage(error), true);
    } finally {
      this.pending.set(false);
    }
  }

  async saveCapital(): Promise<void> {
    const amount = this.capitalAmount();
    if (Number.isFinite(amount) && amount !== null && amount > this.maxCapital) {
      this.notices.show(this.capitalValidationMessage(), true);
      return;
    }
    if (!Number.isFinite(amount) || (amount as number) < 0.01) {
      this.notices.show('Informe um capital válido em USD.', true);
      return;
    }
    this.pending.set(true);
    try {
      await this.marketData.configureCapital(amount as number);
      this.closeDialogById('capitalDialog');
      this.capitalAmount.set(null);
      this.notices.show('Capital da conta de demonstração salvo.');
    } catch (error) {
      this.notices.show(this.errorMessage(error), true);
    } finally {
      this.pending.set(false);
    }
  }

  async confirmReset(): Promise<void> {
    if (this.resetPhrase().trim().toUpperCase() !== 'APAGAR') {
      this.notices.show('Digite APAGAR para confirmar a limpeza da conta.', true);
      return;
    }
    this.pending.set(true);
    try {
      await this.marketData.resetSimulation();
      this.closeDialogById('resetDialog');
      this.resetPhrase.set('');
      this.notices.show('Dados da simulação removidos.');
    } catch (error) {
      this.notices.show(this.errorMessage(error), true);
    } finally {
      this.pending.set(false);
    }
  }

  async downloadBackup(): Promise<void> {
    this.pending.set(true);
    try {
      const simulation = await this.marketData.exportSimulation();
      const backup: PulseDeskBackup = {
        format: 'pulsedesk-backup',
        version: 1,
        exportedAt: Date.now(),
        profile: { name: this.profileNameDraft(), avatar: this.profileAvatarDraft() },
        simulation
      };
      const contents = JSON.stringify(backup, null, 2);
      if (new Blob([contents]).size > 5 * 1024 * 1024) throw new Error('Este arquivo excede o limite de 5 MB para restauração.');
      const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `pulsedesk-backup-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
      this.notices.show('Backup do perfil e da simulação exportado.');
    } catch (error) {
      this.notices.show(this.errorMessage(error), true);
    } finally {
      this.pending.set(false);
    }
  }

  async selectBackup(event: Event, profileDialog: HTMLDialogElement, restoreDialog: HTMLDialogElement): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      this.notices.show('O backup deve ter no máximo 5 MB.', true);
      return;
    }
    try {
      const parsed: unknown = JSON.parse(await file.text());
      if (!this.isPulseDeskBackup(parsed)) throw new Error('Arquivo inválido. Selecione um backup do Pulse Desk versão 1.');
      this.pendingBackup.set(parsed);
      this.backupRestorePhrase.set('');
      profileDialog.close();
      this.openDialog(restoreDialog);
    } catch (error) {
      this.notices.show(this.errorMessage(error), true);
    }
  }

  async confirmBackupRestore(dialog: HTMLDialogElement): Promise<void> {
    const backup = this.pendingBackup();
    if (!backup) return;
    if (this.backupRestorePhrase().trim().toUpperCase() !== 'RESTAURAR') {
      this.notices.show('Digite RESTAURAR para confirmar a substituição da simulação atual.', true);
      return;
    }

    const profileKey = 'pulsedesk.profile.v1';
    let previousProfile: string | null = null;
    let profileStored = false;
    this.pending.set(true);
    try {
      previousProfile = localStorage.getItem(profileKey);
      localStorage.setItem(profileKey, JSON.stringify(backup.profile));
      profileStored = true;
      await this.marketData.importSimulation(backup.simulation);
      this.profileName.set(backup.profile.name);
      this.profileNameDraft.set(backup.profile.name);
      this.profileAvatar.set(backup.profile.avatar);
      this.profileAvatarDraft.set(backup.profile.avatar);
      this.pendingBackup.set(null);
      this.backupRestorePhrase.set('');
      dialog.close();
      this.notices.show('Perfil e simulação restaurados neste navegador.');
    } catch (error) {
      if (profileStored) {
        try {
          if (previousProfile === null) localStorage.removeItem(profileKey);
          else localStorage.setItem(profileKey, previousProfile);
        } catch {
          this.notices.show('A restauração falhou e o perfil local não pôde ser revertido.', true);
          this.pending.set(false);
          return;
        }
      }
      this.notices.show(this.errorMessage(error), true);
    } finally {
      this.pending.set(false);
    }
  }

  async cancelOpenOrders(): Promise<void> {
    const count = this.marketData.snapshot()?.orders.filter((order) => order.status === 'open').length ?? 0;
    if (!count) return;
    this.pending.set(true);
    try {
      await this.marketData.cancelOpenOrders();
      this.notices.show(`${count} ordem(ns) cancelada(s).`);
    } catch (error) {
      this.notices.show(this.errorMessage(error), true);
    } finally {
      this.pending.set(false);
    }
  }

  async cancelOrder(orderId: string): Promise<void> {
    this.pending.set(true);
    try {
      await this.marketData.cancelOrder(orderId);
      this.notices.show('Ordem cancelada.');
    } catch (error) {
      this.notices.show(this.errorMessage(error), true);
    } finally {
      this.pending.set(false);
    }
  }

  private closeDialogById(id: string): void {
    document.querySelector<HTMLDialogElement>(`#${id}`)?.close();
  }

  private maxBuyQuantityForBudget(levels: BookLevel[], budget: number): number {
    let remainingBudget = budget;
    let quantityAvailable = 0;
    for (const level of levels) {
      if (level.price <= 0 || level.quantity <= 0 || remainingBudget <= 0) continue;
      const affordable = remainingBudget / (level.price * 1.001);
      const fillable = Math.min(level.quantity, affordable);
      quantityAvailable += fillable;
      remainingBudget -= fillable * level.price * 1.001;
      if (fillable + 1e-8 < level.quantity) break;
    }
    return quantityAvailable;
  }

  private loadProfile(): void {
    try {
      const stored = localStorage.getItem('pulsedesk.profile.v1');
      if (!stored) return;
      const profile = JSON.parse(stored) as { name?: unknown; avatar?: unknown };
      if (typeof profile.name === 'string' && profile.name.trim().length >= 2 && profile.name.trim().length <= 40) {
        this.profileName.set(profile.name.trim().replace(/\s+/g, ' '));
      }
      if (typeof profile.avatar === 'string' && profile.avatar.length <= 700_000 && /^data:image\/(png|jpeg|webp);base64,/.test(profile.avatar)) {
        this.profileAvatar.set(profile.avatar);
      }
    } catch {
      this.notices.show('O perfil local não pôde ser carregado. Você ainda pode editar e salvar outro perfil.', true);
    }
  }

  private isPulseDeskBackup(value: unknown): value is PulseDeskBackup {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const backup = value as Partial<PulseDeskBackup>;
    const profile = backup.profile;
    const simulation = backup.simulation as SimulationBackup | undefined;
    if (backup.format !== 'pulsedesk-backup' || backup.version !== 1 || !Number.isFinite(backup.exportedAt) || !profile || typeof profile.name !== 'string' || profile.name.trim().length < 2 || profile.name.trim().length > 40) return false;
    if (profile.avatar !== null && (typeof profile.avatar !== 'string' || profile.avatar.length > 700_000 || !/^data:image\/(png|jpeg|webp);base64,/.test(profile.avatar))) return false;
    return Boolean(simulation && simulation.format === 'pulsedesk-simulation' && simulation.version === 1 && Number.isFinite(simulation.exportedAt) && simulation.account && typeof simulation.account === 'object');
  }

  private makeInitials(name: string): string {
    const words = name.trim().split(/\s+/).filter(Boolean);
    if (!words.length) return 'MC';
    return (words.length > 1 ? `${words[0][0]}${words.at(-1)?.[0]}` : words[0].slice(0, 2)).toUpperCase();
  }

  private errorMessage(error: unknown): string {
    const candidate = error as { error?: unknown; message?: unknown };
    if (typeof candidate?.error === 'string') return candidate.error;
    if (candidate?.error && typeof candidate.error === 'object') {
      const response = candidate.error as { error?: unknown };
      if (typeof response.error === 'string') return response.error;
    }
    if (typeof candidate?.message === 'string') return candidate.message;
    return 'A solicitação não foi concluída. A conta local permaneceu sem alterações.';
  }
}
