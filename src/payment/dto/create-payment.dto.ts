import {
  IsString,
  IsNotEmpty,
  Matches,
  IsOptional,
  IsNumber,
  Min,
  IsInt,
  IsObject,
  IsBoolean,
} from 'class-validator';
import { Type } from 'class-transformer';

// ─── KARTA ULASH ──────────────────────────────────────────────────────────────

export class CreateCardDto {
  /** Karta raqami: 16 raqam, bo'shliqlar avtomatik tozalanadi. */
  @IsString()
  @IsNotEmpty({ message: 'Karta raqamini kiriting' })
  @Matches(/^[\d\s]{13,23}$/, { message: 'Karta raqami noto\'g\'ri' })
  cardNumber!: string;

  /** Format: MM/YY yoki MMYY. Service ichida YYMM ga aylantiriladi. */
  @IsString()
  @IsNotEmpty({ message: 'Amal qilish muddatini kiriting' })
  @Matches(/^(0[1-9]|1[0-2])\/?\d{2}$/, {
    message: 'Muddat MM/YY formatida bo\'lishi kerak (masalan, 03/28)',
  })
  expireDate!: string;

  /** Telefon raqami. + bilan yoki +siz, bo'shliq/qavslar avtomatik tozalanadi. */
  @IsString()
  @IsNotEmpty({ message: 'Telefon raqamini kiriting' })
  @Matches(/^\+?\d{9,15}$/, { message: 'Telefon raqami noto\'g\'ri' })
  phoneNumber!: string;
}

export class ConfirmCardDto {
  @IsString()
  @IsNotEmpty({ message: 'cardId kerak' })
  cardId!: string;

  @IsString()
  @IsNotEmpty({ message: 'OTP kodni kiriting' })
  @Matches(/^[A-Za-z0-9]{4,8}$/, { message: 'OTP 4-8 ta harf yoki raqamdan iborat bo\'lishi kerak' })
  otp!: string;

  @IsString()
  @IsOptional()
  cardName?: string;

  @IsString()
  @IsOptional()
  pinfl?: string;
}

export class ResendOtpDto {
  @IsString()
  @IsNotEmpty({ message: 'cardId kerak' })
  cardId!: string;
}

// ─── ESCROW: HOLD / CHARGE / DISMISS / PAYOUT ─────────────────────────────────

export class HoldFundsDto {
  @IsString()
  @IsNotEmpty()
  cardId!: string;

  /** Summa SO'M'da. Service ichida tiyinga aylantiriladi. */
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'Summa raqam bo\'lishi kerak' })
  @Min(1000, { message: 'Eng kam summa 1000 so\'m' })
  amount!: number;

  @IsString()
  @IsNotEmpty()
  contractId!: string;
}

export class FulfillEscrowDto {
  @IsString()
  @IsNotEmpty()
  transactionId!: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1000)
  amount!: number;
}

export class CancelHoldDto {
  @IsString()
  @IsNotEmpty()
  transactionId!: string;
}

export class PayoutDto {
  /** Ijrochi (sotuvchi) kartasining IDsi. */
  @IsString()
  @IsNotEmpty()
  toCardId!: string;

  /** Summa SO'M'da. */
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1000)
  amount!: number;

  /** Bog'liq shartnoma IDsi (idempotency uchun). */
  @IsString()
  @IsNotEmpty()
  contractId!: string;
}

// ─── PAYLOV WEBHOOK ──────────────────────────────────────────────────────────

/**
 * Paylov tomonidan yuboriladigan callback. Aniq sxema docs.paylov.uz da,
 * lekin minimal kerakli maydonlar quyidagilar.
 */
export class PaylovWebhookDto {
  @IsOptional()
  @IsString()
  method?: string;

  @IsOptional()
  @IsString()
  transactionId?: string;

  @IsOptional()
  @IsString()
  extId?: string;

  @IsOptional()
  @IsString()
  state?: string;

  @IsOptional()
  @IsObject()
  params?: Record<string, any>;

  @IsOptional()
  @IsObject()
  result?: Record<string, any>;

  @IsOptional()
  @IsObject()
  error?: Record<string, any>;

  @IsOptional()
  @IsBoolean()
  cancelled?: boolean;
}

// ─── ESKI DTO (kompatibilik uchun) ───────────────────────────────────────────

export class CheckCardFieldDto {
  @IsString()
  cardId!: string;

  @IsString()
  @IsOptional()
  pinfl?: string;

  @IsString()
  @IsOptional()
  phone?: string;
}
