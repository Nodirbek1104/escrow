/**
 * Platform commission calculator.
 *
 * Reads `PLATFORM_COMMISSION_PERCENT` from env (defaults to 5). Buyer is
 * charged `amount + commission` on hold; executor receives `amount` on
 * payout. Commission is computed once at contract create time and frozen
 * on the contract row, so future percentage changes do not retroactively
 * rewrite existing contracts.
 */

const DEFAULT_PERCENT = 5;

export function getCommissionPercent(): number {
  const raw = process.env.PLATFORM_COMMISSION_PERCENT;
  const n = raw === undefined ? DEFAULT_PERCENT : Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 100) return DEFAULT_PERCENT;
  return n;
}

/** Round to 2 decimals (so'm with tiyin, even if we don't display tiyin). */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function computeCommission(amount: number): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return round2((amount * getCommissionPercent()) / 100);
}

export function totalCharge(amount: number, commission?: number): number {
  const c = commission ?? computeCommission(amount);
  return round2(amount + c);
}
