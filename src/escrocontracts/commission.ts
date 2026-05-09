/**
 * Platform commission helpers. Pure functions — the percent is supplied
 * by the caller (typically SettingsService.getCommissionPercent()), which
 * lets us live-tune the rate from the admin panel without redeploying.
 *
 * Commission is computed once at contract create time and frozen on the
 * contract row, so future percentage changes do not retroactively rewrite
 * existing contracts.
 */

const DEFAULT_PERCENT = 5;

/** Env-backed fallback used only before SettingsService is available
 *  (e.g. very first boot, or contexts that don't take a setting). */
export function envCommissionPercent(): number {
  const raw = process.env.PLATFORM_COMMISSION_PERCENT;
  const n = raw === undefined ? DEFAULT_PERCENT : Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 100) return DEFAULT_PERCENT;
  return n;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function computeCommission(amount: number, percent: number): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  if (!Number.isFinite(percent) || percent < 0) return 0;
  return round2((amount * percent) / 100);
}

export function totalCharge(amount: number, commission: number): number {
  return round2(Number(amount ?? 0) + Number(commission ?? 0));
}
