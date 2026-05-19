import { BadRequestException } from '@nestjs/common';
import {
  formatSum,
  formatTiyinAsSum,
  sumToTiyin,
  tiyinToSum,
} from './money.util';

describe('money.util', () => {
  describe('sumToTiyin', () => {
    it('butun so\'mni tiyinga aylantiradi', () => {
      expect(sumToTiyin(1)).toBe(100);
      expect(sumToTiyin(1500)).toBe(150_000);
      expect(sumToTiyin(1_500_000)).toBe(150_000_000);
    });

    it('o\'nlik so\'mni to\'g\'ri yaxlitlaydi', () => {
      expect(sumToTiyin(1.25)).toBe(125);
      expect(sumToTiyin(0.99)).toBe(99);
      // float drift sinovi: 0.1 + 0.2 = 0.30000000000000004
      expect(sumToTiyin(0.1 + 0.2)).toBe(30);
    });

    it('0 ni qabul qiladi', () => {
      expect(sumToTiyin(0)).toBe(0);
    });

    it('salbiy yoki noto\'g\'ri qiymatga BadRequest tashlaydi', () => {
      expect(() => sumToTiyin(-1)).toThrow(BadRequestException);
      expect(() => sumToTiyin(NaN)).toThrow(BadRequestException);
      expect(() => sumToTiyin(Infinity)).toThrow(BadRequestException);
    });
  });

  describe('tiyinToSum', () => {
    it('butun tiyinni so\'mga aylantiradi', () => {
      expect(tiyinToSum(100)).toBe(1);
      expect(tiyinToSum(150_000)).toBe(1500);
      expect(tiyinToSum(150_000_000)).toBe(1_500_000);
    });

    it('string va bigint inputni qabul qiladi (DB raw qiymatlari)', () => {
      expect(tiyinToSum('150000')).toBe(1500);
      expect(tiyinToSum(BigInt(150_000))).toBe(1500);
    });

    it('null/undefined/NaN/salbiy uchun 0 qaytaradi (lenient display mode)', () => {
      expect(tiyinToSum(NaN)).toBe(0);
      expect(tiyinToSum(-100)).toBe(0);
      expect(tiyinToSum(null as unknown as number)).toBe(0);
      expect(tiyinToSum(undefined as unknown as number)).toBe(0);
    });

    it('o\'nli tiyin qiymatini yaxlitlaydi (haqiqatda bo\'lmasligi kerak, lekin xavfsiz)', () => {
      expect(tiyinToSum(150)).toBe(1.5);
      expect(tiyinToSum(199)).toBe(1.99);
    });
  });

  describe('round-trip', () => {
    it('sum -> tiyin -> sum lossless qoladi (oddiy butun qiymatlar)', () => {
      [0, 1, 100, 1500, 1_500_000, 99_999_999].forEach((sum) => {
        expect(tiyinToSum(sumToTiyin(sum))).toBe(sum);
      });
    });
  });

  describe('formatSum', () => {
    it('uz-UZ locale\'da bo\'shliq separator bilan formatlaydi', () => {
      const out = formatSum(1_500_000);
      // uz-UZ NBSP yoki oddiy bo'shliq ishlatishi mumkin
      expect(out.replace(/\s/g, '')).toBe('1500000');
    });

    it('NaN/Infinity uchun 0 ko\'rsatadi', () => {
      expect(formatSum(NaN)).toBe('0');
      expect(formatSum(Infinity)).toBe('0');
    });
  });

  describe('formatTiyinAsSum', () => {
    it('tiyinni "X so\'m" shaklida chiqaradi', () => {
      const out = formatTiyinAsSum(150_000_000);
      expect(out).toContain("so'm");
      expect(out.replace(/\s/g, '')).toContain('1500000');
    });

    it('string tiyin qabul qiladi (DB query natijasi)', () => {
      const out = formatTiyinAsSum('150000');
      expect(out.replace(/\s/g, '')).toContain('1500');
    });
  });
});
