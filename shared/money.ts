// All money is handled as integer cents. Never use floats for amounts.

/** The platform's cut of one ticket, in cents. `bps` is basis points (500 = 5%). */
export function commissionCents(priceCents: number, bps: number): number {
  return Math.round((priceCents * bps) / 10_000);
}

/** What the host keeps from one ticket after the platform's cut. */
export function hostNetCents(priceCents: number, bps: number): number {
  return priceCents - commissionCents(priceCents, bps);
}

export function formatMoney(cents: number, currency: string): string {
  const whole = cents % 100 === 0;
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

export function formatMoneyExact(cents: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100);
}
