const currencyFormat = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

const quantityFormat = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 8
});

export function money(value: number | null | undefined): string {
  return Number.isFinite(value) ? currencyFormat.format(value as number) : '—';
}

export function signedMoney(value: number | null | undefined): string {
  if (!Number.isFinite(value)) return '—';
  const amount = value as number;
  return `${amount > 0 ? '+' : ''}${currencyFormat.format(amount)}`;
}

export function signedPercent(value: number | null | undefined, digits = 2): string {
  if (!Number.isFinite(value)) return '—';
  const amount = value as number;
  return `${amount > 0 ? '+' : ''}${amount.toFixed(digits)}%`;
}

export function quantity(value: number | null | undefined): string {
  return Number.isFinite(value) ? quantityFormat.format(value as number) : '—';
}

export function shortTime(value: number | null | undefined): string {
  if (!Number.isFinite(value)) return '—';
  return new Intl.DateTimeFormat('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: 'America/Sao_Paulo'
  }).format(new Date(value as number));
}

export function dateTime(value: number | null | undefined): string {
  if (!Number.isFinite(value)) return '—';
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'medium',
    timeZone: 'America/Sao_Paulo'
  }).format(new Date(value as number));
}
