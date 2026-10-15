import { randomUUID } from "node:crypto";

const feeRate = 0.001;

export class TradingEngine {
  #journal;
  #market;
  #orders = [];
  #fills = [];
  #idempotency = new Map();
  #positions = new Map();
  #cash = 0;
  #realizedPnl = 0;
  #capitalConfigured = false;
  #queue = Promise.resolve();

  constructor(journal, market) {
    this.#journal = journal;
    this.#market = market;
  }

  restore(events) {
    let accountInitialized = false;
    for (const event of events) {
      if (event.type === "account.reset") {
        this.#apply(event);
        accountInitialized = false;
        continue;
      }
      if (event.type === "account.backup.imported") {
        this.#apply(event);
        accountInitialized = event.account.capitalConfigured;
        continue;
      }
      if (event.type === "account.capital.configured") accountInitialized = true;
      if (accountInitialized) this.#apply(event);
    }
  }

  get positions() {
    return [...this.#positions.values()].filter((position) => position.quantity > 0.00000001).map((position) => {
      const reserved = this.#orders.filter((order) => order.symbol === position.symbol && order.side === "sell" && order.status === "open").reduce((sum, order) => sum + this.#remaining(order), 0);
      return { ...position, availableQuantity: Math.max(0, position.quantity - reserved) };
    });
  }

  get orders() {
    return this.#orders.slice(0, 100).map((order) => ({ ...order }));
  }

  get fills() {
    return this.#fills;
  }

  get cash() {
    return this.#capitalConfigured ? this.#cash : 0;
  }

  get realizedPnl() {
    return this.#capitalConfigured ? this.#realizedPnl : 0;
  }

  get capitalConfigured() {
    return this.#capitalConfigured;
  }

  get capitalEditable() {
    return this.#orders.length === 0 && this.#fills.length === 0 && this.#positions.size === 0;
  }

  get hasSimulationData() {
    return this.#capitalConfigured || this.#orders.length > 0 || this.#fills.length > 0 || this.#positions.size > 0;
  }

  async exportBackup() {
    await this.#queue;
    const positions = [...this.#positions.values()].map((position) => ({ ...position }));
    const initialCapital = this.#capitalConfigured
      ? this.#cash + positions.reduce((sum, position) => sum + position.quantity * position.averagePrice, 0) - this.#realizedPnl
      : null;
    const backup = {
      format: "pulsedesk-simulation",
      version: 1,
      exportedAt: Date.now(),
      account: {
        capitalConfigured: this.#capitalConfigured,
        initialCapital,
        cash: this.#capitalConfigured ? this.#cash : 0,
        realizedPnl: this.#capitalConfigured ? this.#realizedPnl : 0,
        positions,
        orders: this.#orders.map((order) => ({ ...order })),
        fills: this.#fills.map((fill) => ({ ...fill }))
      }
    };
    if (backup.account.orders.length > 15000 || Buffer.byteLength(JSON.stringify(backup)) > 3_800_000) throw new Error("O histórico local excede o limite de tamanho do backup");
    return backup;
  }

  async importBackup(input) {
    return this.#serialize(async () => {
      const account = this.#normalizeBackup(input);
      const event = { type: "account.backup.imported", time: Date.now(), account };
      await this.#journal.replace(event);
      this.#apply(event);
      return { imported: true, capitalConfigured: this.#capitalConfigured };
    });
  }

  get availableCash() {
    return this.#capitalConfigured ? this.#cash - this.#reservedCash() : 0;
  }

  async configureCapital(input) {
    return this.#serialize(async () => {
      const rawAmount = input?.amount;
      const amountText = typeof rawAmount === "number" ? String(rawAmount) : typeof rawAmount === "string" ? rawAmount.trim() : "";
      const amount = /^\d+(?:\.\d{1,2})?$/.test(amountText) ? Number(amountText) : NaN;
      if (!Number.isFinite(amount) || amount < 0.01 || amount > 1000000000) throw new Error("Informe um capital inicial entre US$ 0,01 e US$ 1.000.000.000,00");
      if (this.#orders.length || this.#fills.length || this.#positions.size) throw new Error("O capital só pode ser ajustado antes da primeira ordem");
      const event = { type: "account.capital.configured", amount, time: Date.now() };
      await this.#journal.append(event);
      this.#apply(event);
      return { amount: this.#cash };
    });
  }

  async reset() {
    return this.#serialize(async () => {
      const event = { type: "account.reset", time: Date.now() };
      await this.#journal.replace(event);
      this.#apply(event);
      return { reset: true };
    });
  }

  async submit(input) {
    return this.#serialize(async () => {
      if (!this.#capitalConfigured) throw new Error("Configure o capital inicial antes de enviar ordens");
      const normalized = this.#validate(input);
      const previousId = this.#idempotency.get(normalized.idempotencyKey);
      if (previousId) return { order: this.#orders.find((order) => order.id === previousId), duplicate: true };
      if (!this.#market.hasFreshExecutionPrice(normalized.symbol)) throw new Error("Ordens simuladas exigem cotação e livro de ofertas atuais da Coinbase");
      if (this.#orders.filter((order) => order.status === "open").length >= 100) throw new Error("Limite de ordens abertas atingido");
      this.#validateCapacity(normalized);
      const order = { id: randomUUID(), ...normalized, status: "open", createdAt: Date.now(), filledAt: null, averageFillPrice: null, filledQuantity: 0, filledNotional: 0, fee: 0 };
      const execution = this.#buildFills(order);
      if (order.type === "market" && !execution.fills.length) throw new Error("Livro de ofertas atual indisponível para estimar uma execução realista");
      if (order.type === "market" && execution.filledQuantity + 0.00000001 < order.quantity) throw new Error("Profundidade atual insuficiente para executar toda a ordem a mercado");
      const event = { type: "order.accepted", order, fills: execution.fills, bookUpdatedAt: execution.bookUpdatedAt };
      await this.#journal.append(event);
      this.#apply(event);
      if (execution.fills.length) this.#market.consumeExecutionLiquidity(order.symbol, order.side, execution.bookUpdatedAt, execution.fills);
      return { order: this.#orders.find((item) => item.id === order.id), duplicate: false };
    });
  }

  async cancel(orderId) {
    return this.#serialize(async () => {
      const order = this.#orders.find((item) => item.id === orderId);
      if (!order) throw new Error("Ordem não encontrada");
      if (order.status !== "open") throw new Error("Somente ordens abertas podem ser canceladas");
      const event = { type: "order.cancelled", orderId, cancelledAt: Date.now() };
      await this.#journal.append(event);
      this.#apply(event);
      return this.#orders.find((item) => item.id === orderId);
    });
  }

  async matchLimitOrders() {
    return this.#serialize(async () => {
      const openOrders = this.#orders.filter((order) => order.status === "open");
      for (const order of openOrders) {
        const execution = this.#buildFills(order, true);
        if (!execution.fills.length) continue;
        const event = { type: "order.filled", orderId: order.id, fills: execution.fills, bookUpdatedAt: execution.bookUpdatedAt };
        await this.#journal.append(event);
        this.#apply(event);
        this.#market.consumeExecutionLiquidity(order.symbol, order.side, execution.bookUpdatedAt, execution.fills);
      }
    });
  }

  #validate(input) {
    const symbol = typeof input?.symbol === "string" ? input.symbol.toUpperCase() : "";
    const side = input?.side;
    const type = input?.type;
    const quantity = Number(input?.quantity);
    const limitPrice = input?.limitPrice == null || input.limitPrice === "" ? null : Number(input.limitPrice);
    const strategy = typeof input?.strategy === "string" ? input.strategy.trim() : "discretionary";
    const thesis = typeof input?.thesis === "string" ? input.thesis.trim() : "";
    const idempotencyKey = typeof input?.idempotencyKey === "string" ? input.idempotencyKey.trim() : "";
    if (!this.#market.hasSymbol(symbol)) throw new Error("Ativo inválido");
    if (side !== "buy" && side !== "sell") throw new Error("Direção inválida");
    if (type !== "market" && type !== "limit") throw new Error("Tipo de ordem inválido");
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1000000) throw new Error("Quantidade fora do limite");
    if (type === "limit" && (!Number.isFinite(limitPrice) || limitPrice <= 0)) throw new Error("Informe um preço limite válido");
    if (type === "market" && limitPrice !== null) throw new Error("Ordem a mercado não aceita preço limite");
    if (!strategy || strategy.length > 48 || !/^[A-Za-z0-9 _.-]+$/.test(strategy)) throw new Error("Informe uma estratégia válida, com até 48 caracteres");
    if (thesis.length > 500) throw new Error("A tese da ordem deve ter no máximo 500 caracteres");
    if (!idempotencyKey || idempotencyKey.length > 96) throw new Error("Chave de idempotência inválida");
    return { symbol, side, type, quantity, limitPrice, strategy, thesis, idempotencyKey };
  }

  #normalizeBackup(input) {
    const invalid = () => new Error("Arquivo de simulação inválido ou incompatível");
    if (input?.format !== "pulsedesk-simulation" || input?.version !== 1 || !Number.isFinite(input?.exportedAt)) throw invalid();
    const source = input.account;
    if (!source || typeof source !== "object" || Array.isArray(source) || typeof source.capitalConfigured !== "boolean") throw invalid();
    const finite = (value) => typeof value === "number" && Number.isFinite(value);
    const validTime = (value) => finite(value) && value >= 0 && value <= 8640000000000000;
    const symbols = new Set(["BTCUSD", "ETHUSD", "SOLUSD", "XRPUSD", "ADAUSD"]);
    if (!Array.isArray(source.positions) || source.positions.length > symbols.size || !Array.isArray(source.orders) || source.orders.length > 15000 || !Array.isArray(source.fills) || source.fills.length > 500) throw invalid();
    if (!finite(source.cash) || !finite(source.realizedPnl) || (source.capitalConfigured && (!finite(source.initialCapital) || source.initialCapital < 0.01 || source.initialCapital > 1000000000))) throw invalid();
    if (!source.capitalConfigured && (source.cash !== 0 || source.realizedPnl !== 0 || source.positions.length || source.orders.length || source.fills.length)) throw invalid();

    const positionSymbols = new Set();
    const positions = source.positions.map((position) => {
      if (!position || typeof position !== "object" || !symbols.has(position.symbol) || positionSymbols.has(position.symbol) || !finite(position.quantity) || position.quantity < 0 || position.quantity > 1000000000000 || !finite(position.averagePrice) || position.averagePrice < 0 || position.averagePrice > 1000000000000 || !finite(position.dayOpen) || position.dayOpen < 0 || position.dayOpen > 1000000000000 || (position.quantity > 0 && (!position.averagePrice || !position.dayOpen))) throw invalid();
      positionSymbols.add(position.symbol);
      return { symbol: position.symbol, quantity: position.quantity, averagePrice: position.averagePrice, dayOpen: position.dayOpen };
    });
    const positionCost = positions.reduce((sum, position) => sum + position.quantity * position.averagePrice, 0);
    if (source.capitalConfigured && Math.abs(source.cash + positionCost - source.realizedPnl - source.initialCapital) > Math.max(0.01, source.initialCapital * 0.00000001)) throw invalid();

    const orderIds = new Set();
    const idempotencyKeys = new Set();
    const orders = source.orders.map((order) => {
      if (!order || typeof order !== "object" || typeof order.id !== "string" || !/^[a-f0-9-]{16,64}$/i.test(order.id) || orderIds.has(order.id) || !symbols.has(order.symbol) || !["buy", "sell"].includes(order.side) || !["market", "limit"].includes(order.type) || !["open", "filled", "cancelled"].includes(order.status) || !finite(order.quantity) || order.quantity <= 0 || order.quantity > 1000000 || !validTime(order.createdAt) || typeof order.idempotencyKey !== "string" || !order.idempotencyKey.length || order.idempotencyKey.length > 96 || idempotencyKeys.has(order.idempotencyKey)) throw invalid();
      if ((order.type === "limit" && (!finite(order.limitPrice) || order.limitPrice <= 0 || order.limitPrice > 1000000000000)) || (order.type === "market" && order.limitPrice !== null) || (order.status === "open" && order.type !== "limit")) throw invalid();
      const filledQuantity = order.filledQuantity == null ? (order.status === "filled" ? order.quantity : 0) : order.filledQuantity;
      if (!finite(filledQuantity) || filledQuantity < 0 || filledQuantity > order.quantity + 0.00000001) throw invalid();
      if (order.status === "filled" && (filledQuantity + 0.00000001 < order.quantity || !validTime(order.filledAt) || !finite(order.averageFillPrice) || order.averageFillPrice <= 0)) throw invalid();
      if (order.status === "open" && (filledQuantity + 0.00000001 >= order.quantity || order.filledAt !== null)) throw invalid();
      if (order.status === "cancelled" && order.filledAt !== null) throw invalid();
      if (filledQuantity > 0 && (!finite(order.averageFillPrice) || order.averageFillPrice <= 0)) throw invalid();
      if (filledQuantity === 0 && order.averageFillPrice !== null) throw invalid();
      if (order.status === "cancelled" && !validTime(order.cancelledAt)) throw invalid();
      if (order.fee != null && (!finite(order.fee) || order.fee < 0)) throw invalid();
      orderIds.add(order.id);
      idempotencyKeys.add(order.idempotencyKey);
      const normalized = {
        id: order.id, symbol: order.symbol, side: order.side, type: order.type, quantity: order.quantity,
        limitPrice: order.limitPrice, idempotencyKey: order.idempotencyKey, status: order.status,
        createdAt: order.createdAt, filledAt: order.filledAt, averageFillPrice: order.averageFillPrice,
        filledQuantity, filledNotional: finite(order.filledNotional) ? order.filledNotional : filledQuantity * (order.averageFillPrice ?? 0)
      };
      if (typeof order.strategy === "string" && /^[A-Za-z0-9 _.-]{1,48}$/.test(order.strategy)) normalized.strategy = order.strategy;
      if (typeof order.thesis === "string" && order.thesis.length <= 500) normalized.thesis = order.thesis;
      if (finite(order.fee)) normalized.fee = order.fee;
      if (validTime(order.cancelledAt)) normalized.cancelledAt = order.cancelledAt;
      return normalized;
    });

    const fillIds = new Set();
    const fills = source.fills.map((fill) => {
      if (!fill || typeof fill !== "object" || typeof fill.id !== "string" || !/^[a-f0-9-]{16,64}$/i.test(fill.id) || fillIds.has(fill.id) || typeof fill.orderId !== "string" || !orderIds.has(fill.orderId) || !symbols.has(fill.symbol) || !["buy", "sell"].includes(fill.side) || !finite(fill.quantity) || fill.quantity <= 0 || fill.quantity > 1000000 || !finite(fill.price) || fill.price <= 0 || fill.price > 1000000000000 || !finite(fill.notional) || fill.notional <= 0 || !finite(fill.fee) || fill.fee < 0 || !validTime(fill.time)) throw invalid();
      const order = orders.find((item) => item.id === fill.orderId);
      if (!order || order.symbol !== fill.symbol || order.side !== fill.side || fill.quantity > order.quantity || Math.abs(fill.price * fill.quantity - fill.notional) > Math.max(0.000001, fill.notional * 0.000000001) || Math.abs(fill.notional * feeRate - fill.fee) > Math.max(0.000001, fill.notional * feeRate * 0.000000001)) throw invalid();
      fillIds.add(fill.id);
      return { id: fill.id, orderId: fill.orderId, symbol: fill.symbol, side: fill.side, quantity: fill.quantity, price: fill.price, notional: fill.notional, fee: fill.fee, time: fill.time };
    });

    const fillQuantities = new Map();
    for (const fill of fills) fillQuantities.set(fill.orderId, (fillQuantities.get(fill.orderId) ?? 0) + fill.quantity);
    for (const order of orders) if ((fillQuantities.get(order.id) ?? 0) > order.filledQuantity + 0.00000001) throw invalid();
    const openOrders = orders.filter((order) => order.status === "open");
    if (openOrders.length > 100) throw invalid();
    let reservedCash = 0;
    const reservedPositions = new Map();
    for (const order of openOrders) {
      if (order.side === "buy" && order.type === "limit") reservedCash += (order.quantity - order.filledQuantity) * order.limitPrice * (1 + feeRate);
      else if (order.side === "sell") reservedPositions.set(order.symbol, (reservedPositions.get(order.symbol) ?? 0) + order.quantity - order.filledQuantity);
    }
    if (!Number.isFinite(reservedCash) || reservedCash > source.cash + 0.000001) throw invalid();
    for (const [symbol, quantity] of reservedPositions) {
      if (quantity > (positions.find((position) => position.symbol === symbol)?.quantity ?? 0) + 0.00000001) throw invalid();
    }
    return {
      capitalConfigured: source.capitalConfigured,
      initialCapital: source.capitalConfigured ? source.initialCapital : null,
      cash: source.capitalConfigured ? source.cash : 0,
      realizedPnl: source.capitalConfigured ? source.realizedPnl : 0,
      positions,
      orders,
      fills
    };
  }

  #validateCapacity(order) {
    const price = order.type === "limit" ? order.limitPrice : this.#market.getPrice(order.symbol);
    if (order.side === "buy") {
      const required = price * order.quantity * (1 + feeRate);
      if (required > this.availableCash + 0.000001) throw new Error("Saldo disponível insuficiente");
      return;
    }
    const position = this.#positions.get(order.symbol);
    const reserved = this.#orders.filter((item) => item.symbol === order.symbol && item.side === "sell" && item.status === "open").reduce((sum, item) => sum + this.#remaining(item), 0);
    if (!position || order.quantity > position.quantity - reserved + 0.00000001) throw new Error("Quantidade disponível insuficiente para venda");
  }

  #reservedCash() {
    return this.#orders.filter((order) => order.side === "buy" && order.type === "limit" && order.status === "open").reduce((sum, order) => sum + this.#remaining(order) * order.limitPrice * (1 + feeRate), 0);
  }

  #remaining(order) {
    return Math.max(0, order.quantity - (order.filledQuantity ?? 0));
  }

  #buildFills(order, reservationHeld = false) {
    const remaining = this.#remaining(order);
    const book = this.#market.getExecutionBook(order.symbol, order.side);
    if (!book || !remaining) return { fills: [], filledQuantity: 0, bookUpdatedAt: null };
    const bestPrice = book.levels[0]?.price;
    if (!Number.isFinite(bestPrice)) return { fills: [], filledQuantity: 0, bookUpdatedAt: book.updatedAt };
    if (order.type === "limit" && (order.side === "buy" ? bestPrice > order.limitPrice : bestPrice < order.limitPrice)) return { fills: [], filledQuantity: 0, bookUpdatedAt: book.updatedAt };

    const reservedForThisOrder = reservationHeld && order.side === "buy" && order.type === "limit" ? remaining * order.limitPrice * (1 + feeRate) : 0;
    const buyingBudget = this.availableCash + reservedForThisOrder;
    const position = this.#positions.get(order.symbol);
    const otherSellReservations = this.#orders.filter((item) => item.id !== order.id && item.symbol === order.symbol && item.side === "sell" && item.status === "open").reduce((sum, item) => sum + this.#remaining(item), 0);
    const sellableQuantity = position ? Math.max(0, position.quantity - otherSellReservations) : 0;
    let remainingToFill = Math.min(remaining, order.side === "sell" ? sellableQuantity : remaining);
    let fills = [];
    let spent = 0;
    const time = Date.now();
    for (const level of book.levels) {
      if (remainingToFill <= 0.00000001) break;
      if (order.type === "limit" && (order.side === "buy" ? level.price > order.limitPrice : level.price < order.limitPrice)) break;
      let quantity = Math.min(remainingToFill, level.quantity);
      if (order.side === "buy") quantity = Math.min(quantity, Math.max(0, (buyingBudget - spent) / (level.price * (1 + feeRate))));
      if (quantity <= 0.00000001) break;
      const notional = quantity * level.price;
      const fee = notional * feeRate;
      const slippageBps = order.side === "buy" ? (level.price - bestPrice) / bestPrice * 10000 : (bestPrice - level.price) / bestPrice * 10000;
      fills.push({ id: randomUUID(), orderId: order.id, symbol: order.symbol, side: order.side, quantity, price: level.price, notional, fee, slippageBps, time });
      remainingToFill -= quantity;
      spent += notional + fee;
    }
    return { fills, filledQuantity: fills.reduce((sum, fill) => sum + fill.quantity, 0), bookUpdatedAt: book.updatedAt };
  }

  #apply(event) {
    if (event.type === "account.reset") {
      this.#orders = [];
      this.#fills = [];
      this.#idempotency.clear();
      this.#positions.clear();
      this.#cash = 0;
      this.#realizedPnl = 0;
      this.#capitalConfigured = false;
      return;
    }
    if (event.type === "account.capital.configured") {
      this.#cash = event.amount;
      this.#capitalConfigured = true;
      return;
    }
    if (event.type === "account.backup.imported") {
      const account = event.account;
      this.#capitalConfigured = account.capitalConfigured;
      this.#cash = account.cash;
      this.#realizedPnl = account.realizedPnl;
      this.#positions = new Map(account.positions.map((position) => [position.symbol, { ...position }]));
      this.#orders = account.orders.map((order) => ({ ...order }));
      this.#fills = account.fills.map((fill) => ({ ...fill }));
      this.#idempotency = new Map(account.orders.map((order) => [order.idempotencyKey, order.id]));
      return;
    }
    if (event.type === "order.accepted") {
      const order = { filledQuantity: 0, filledNotional: 0, fee: 0, ...event.order };
      this.#orders.unshift(order);
      this.#idempotency.set(event.order.idempotencyKey, event.order.id);
      const fills = event.fills ?? (event.fill ? [event.fill] : []);
      for (const fill of fills) this.#applyFill(fill);
      return;
    }
    if (event.type === "order.filled") {
      const fills = event.fills ?? (event.fill ? [event.fill] : []);
      for (const fill of fills) this.#applyFill(fill);
      return;
    }
    if (event.type === "order.cancelled") {
      const order = this.#orders.find((item) => item.id === event.orderId);
      if (order) {
        order.status = "cancelled";
        order.cancelledAt = event.cancelledAt;
      }
    }
  }

  #applyFill(fill) {
    const order = this.#orders.find((item) => item.id === fill.orderId);
    if (!order || order.status === "filled") return;
    const current = this.#positions.get(fill.symbol) ?? { symbol: fill.symbol, quantity: 0, averagePrice: 0, dayOpen: fill.price };
    if (fill.side === "buy") {
      const newQuantity = current.quantity + fill.quantity;
      current.averagePrice = (current.quantity * current.averagePrice + fill.notional + fill.fee) / newQuantity;
      current.quantity = newQuantity;
      this.#cash -= fill.notional + fill.fee;
    } else {
      this.#realizedPnl += (fill.price - current.averagePrice) * fill.quantity - fill.fee;
      current.quantity -= fill.quantity;
      this.#cash += fill.notional - fill.fee;
      if (current.quantity <= 0.00000001) current.quantity = 0;
    }
    this.#positions.set(fill.symbol, current);
    const previousQuantity = order.filledQuantity ?? 0;
    const previousNotional = order.filledNotional ?? previousQuantity * (order.averageFillPrice ?? 0);
    order.filledQuantity = previousQuantity + fill.quantity;
    order.filledNotional = previousNotional + fill.notional;
    order.averageFillPrice = order.filledNotional / order.filledQuantity;
    order.fee = (order.fee ?? 0) + fill.fee;
    order.status = order.filledQuantity + 0.00000001 >= order.quantity ? "filled" : "open";
    order.filledAt = order.status === "filled" ? fill.time : null;
    this.#fills.unshift(fill);
    if (this.#fills.length > 500) this.#fills.length = 500;
  }

  #serialize(operation) {
    const result = this.#queue.then(operation);
    this.#queue = result.catch(() => {});
    return result;
  }
}
