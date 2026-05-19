import { BadRequestException } from '@nestjs/common';

/**
 * Yagona pul birligi konvertatsiyasi. Butun loyihada faqat shu helper'lar
 * ishlatilishi kerak — `* 100` yoki `/ 100` raw operatsiyalari taqiqlanadi.
 *
 * Invariant: 1 so'm = 100 tiyin. Paylov API tiyinda ishlaydi, biz tx.amount
 * kolonkasida ham tiyinda saqlaymiz, foydalanuvchi UI'siga esa so'mda
 * ko'rsatamiz.
 */

/** Float drift'dan saqlanish uchun 2 xonalik yaxlitlash. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** So'mni tiyinga aylantirish. Float kirish — chiqish butun son tiyin. */
export function sumToTiyin(amountSum: number): number {
  if (!Number.isFinite(amountSum) || amountSum < 0) {
    throw new BadRequestException("Noto'g'ri summa");
  }
  return Math.round(amountSum * 100);
}

/**
 * Tiyinni so'mga aylantirish. Tx amount DB'da `bigint` yoki `numeric`
 * bo'lishi mumkin, shuning uchun `string | bigint | number` qabul qiladi.
 * Salbiy yoki noto'g'ri bo'lsa 0 qaytaradi (lenient mode — display
 * yo'lida exception throw qilish kerak emas).
 */
export function tiyinToSum(amountTiyin: number | string | bigint): number {
  const n = typeof amountTiyin === 'bigint' ? Number(amountTiyin) : Number(amountTiyin ?? 0);
  if (!Number.isFinite(n) || n < 0) return 0;
  return round2(n / 100);
}

/** So'mni uz-UZ locale'da formatlaydi: 1500000 -> "1 500 000". Butun son. */
export function formatSum(amountSum: number): string {
  const n = Number.isFinite(amountSum) ? amountSum : 0;
  return new Intl.NumberFormat('uz-UZ').format(Math.round(n));
}

/** Tiyinni "1 500 000 so'm" shaklida formatlaydi (display uchun). */
export function formatTiyinAsSum(amountTiyin: number | string | bigint): string {
  return `${formatSum(tiyinToSum(amountTiyin))} so'm`;
}
