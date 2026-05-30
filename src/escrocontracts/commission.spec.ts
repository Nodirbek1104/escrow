import {
  computeCommission,
  envCommissionPercent,
  totalCharge,
} from './commission';

describe('commission helpers', () => {
  describe('computeCommission', () => {
    it('returns 0 for non-positive amount', () => {
      expect(computeCommission(0, 5)).toBe(0);
      expect(computeCommission(-100, 5)).toBe(0);
      expect(computeCommission(NaN, 5)).toBe(0);
    });

    it('returns 0 for invalid percent', () => {
      expect(computeCommission(1000, NaN)).toBe(0);
      expect(computeCommission(1000, -1)).toBe(0);
    });

    it('handles 0% percent', () => {
      expect(computeCommission(1000, 0)).toBe(0);
    });

    it('rounds to 2 decimal places', () => {
      // 333.33 * 5% = 16.6665 → 16.67
      expect(computeCommission(333.33, 5)).toBeCloseTo(16.67, 2);
    });

    it('matches the standard 5% rate', () => {
      expect(computeCommission(1_000_000, 5)).toBe(50_000);
      expect(computeCommission(150, 5)).toBe(7.5);
    });

    it('handles 100% percent (boundary)', () => {
      expect(computeCommission(2_500, 100)).toBe(2_500);
    });
  });

  describe('totalCharge', () => {
    it('sums amount and commission with 2-decimal rounding', () => {
      expect(totalCharge(1000, 50)).toBe(1050);
      expect(totalCharge(333.33, 16.67)).toBe(350);
    });

    it('treats null/undefined as zero', () => {
      expect(totalCharge(undefined as any, 50)).toBe(50);
      expect(totalCharge(1000, undefined as any)).toBe(1000);
    });

    it('roundtrips with computeCommission to a stable total', () => {
      const amount = 999_999;
      const com = computeCommission(amount, 5);
      const total = totalCharge(amount, com);
      // amount + commission must equal total exactly (2dp)
      expect(total).toBeCloseTo(amount + com, 2);
    });
  });

  describe('envCommissionPercent', () => {
    const original = process.env.PLATFORM_COMMISSION_PERCENT;
    afterEach(() => {
      if (original === undefined) {
        delete process.env.PLATFORM_COMMISSION_PERCENT;
      } else {
        process.env.PLATFORM_COMMISSION_PERCENT = original;
      }
    });

    it('returns 5 when env var is missing', () => {
      delete process.env.PLATFORM_COMMISSION_PERCENT;
      expect(envCommissionPercent()).toBe(5);
    });

    it('returns the parsed env value when valid', () => {
      process.env.PLATFORM_COMMISSION_PERCENT = '7.5';
      expect(envCommissionPercent()).toBe(7.5);
    });

    it('falls back to default when env value is invalid', () => {
      process.env.PLATFORM_COMMISSION_PERCENT = 'not-a-number';
      expect(envCommissionPercent()).toBe(5);
      process.env.PLATFORM_COMMISSION_PERCENT = '-2';
      expect(envCommissionPercent()).toBe(5);
      process.env.PLATFORM_COMMISSION_PERCENT = '150';
      expect(envCommissionPercent()).toBe(5);
    });
  });
});
