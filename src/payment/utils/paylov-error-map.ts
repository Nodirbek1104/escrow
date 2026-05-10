/**
 * Paylov javobidan keladigan xato kodlarini frontend'da chiroyli blok
 * sifatida ko'rsatish uchun yagona tarjimaga (kategoriya + matn) aylantiradi.
 *
 * Ko'pchilik kod nomlari sandbox/staging hujjatlardan olingan; nomalum
 * ko'rinishlar uchun message-content asosida heuristik bor.
 */
export type PaymentErrorCategory =
  | 'insufficient_funds'
  | 'card_blocked'
  | 'card_invalid'
  | 'card_expired'
  | 'limit_exceeded'
  | 'otp_required'
  | 'otp_invalid'
  | 'service_unavailable'
  | 'auth'
  | 'unknown';

export interface PaymentErrorMapped {
  category: PaymentErrorCategory;
  /** Foydalanuvchiga ko'rsatiladigan asosiy matn (uz). */
  title: string;
  /** Tavsiya: foydalanuvchi nima qilishi kerak. */
  hint: string;
  /** Paylov'dan kelgan original code va message — debug uchun. */
  raw: { code?: string | number; message?: string };
}

const KEYWORDS: Array<{ cat: PaymentErrorCategory; rx: RegExp }> = [
  // Pul yetmaydi
  { cat: 'insufficient_funds', rx: /(insufficient|not.?enough|нет.{0,4}средств|недостаточн|mablag'?\s*y(o|e)q|balans yetmadi)/i },
  // Bloklangan / pinned
  { cat: 'card_blocked', rx: /(blocked|frozen|locked|заблокирован|карта заблок|karta blok|bloklangan)/i },
  // Limit oshib ketgan
  { cat: 'limit_exceeded', rx: /(daily.?limit|monthly.?limit|limit.{0,15}exceed|лимит|limit oshdi|limit oshib)/i },
  // Karta muddati o'tgan
  { cat: 'card_expired', rx: /(expired|expire|просрочен|muddati|amal qilish muddati)/i },
  // Karta noto'g'ri
  { cat: 'card_invalid', rx: /(invalid.?card|invalid.?pan|card.?number|неверн.{0,4}карт|noto'?gri.?karta)/i },
  // OTP — check the more specific "invalid" pattern first so a generic
  // "otp" mention in an error doesn't get auto-classified as "required".
  { cat: 'otp_invalid', rx: /(wrong.?otp|invalid.?otp|неверн.{0,4}код|otp.{0,15}xato|kod.{0,5}xato)/i },
  { cat: 'otp_required', rx: /(sms.?code|подтверждени|tasdiqlash kodi|otp.?required)/i },
  // Auth
  { cat: 'auth', rx: /(unauth|invalid.?token|access.?denied|forbidden|не.?авторизован)/i },
  // Service down
  { cat: 'service_unavailable', rx: /(service.?unavailable|gateway|timeout|503|502|connection|ECONNREFUSED|ETIMEDOUT)/i },
];

const TITLES: Record<PaymentErrorCategory, { title: string; hint: string }> = {
  insufficient_funds: {
    title: 'Kartada yetarli mablag\'  yo\'q',
    hint:
      'Iltimos, kartani to\'ldiring yoki yetarli balansli boshqa kartani tanlang.',
  },
  card_blocked: {
    title: 'Karta bloklangan',
    hint:
      'Bankingiz bilan bog\'laning yoki ro\'yxatdan boshqa kartani biriktiring.',
  },
  card_invalid: {
    title: 'Karta ma\'lumotlari noto\'g\'ri',
    hint:
      'Karta raqami yoki amal qilish muddatini qaytadan tekshirib, kartani qayta biriktiring.',
  },
  card_expired: {
    title: 'Karta muddati tugagan',
    hint: 'Yangilangan kartani biriktiring va keyin to\'lovni qayta urinib ko\'ring.',
  },
  limit_exceeded: {
    title: 'Tranzaksiya limiti oshdi',
    hint:
      'Bankingizdagi sutkalik yoki oylik limitga yetildi. Bankka murojaat qiling yoki ertaga urinib ko\'ring.',
  },
  otp_required: {
    title: 'SMS tasdiqlash kerak',
    hint: 'Kartangizga yuborilgan SMS kodni kiriting.',
  },
  otp_invalid: {
    title: 'Tasdiqlash kodi noto\'g\'ri',
    hint: 'Kodni qayta kiriting yoki yangi kod so\'rang.',
  },
  service_unavailable: {
    title: 'To\'lov tizimi vaqtinchalik ishlamayapti',
    hint:
      'Paylov tomonida texnik nosozlik. Iltimos, bir-ikki daqiqadan keyin qayta urinib ko\'ring.',
  },
  auth: {
    title: 'Avtorizatsiya xatoligi',
    hint: 'Tizimga qaytadan kiring yoki qo\'llab-quvvatlash xizmatiga murojaat qiling.',
  },
  unknown: {
    title: 'To\'lov amalga oshmadi',
    hint: 'Iltimos, qayta urinib ko\'ring yoki boshqa kartani tanlang.',
  },
};

/**
 * Paylov javobidagi error obyektini (yoki freeform message'ni) PaymentErrorMapped'ga aylantiradi.
 */
export function mapPaylovError(input: {
  code?: string | number;
  message?: string;
}): PaymentErrorMapped {
  const code = input?.code != null ? String(input.code).toLowerCase() : '';
  const msg = String(input?.message ?? '');

  // 1) explicit code-based mapping first (most reliable)
  if (/insufficient|funds/.test(code)) return build('insufficient_funds', input);
  if (/block/.test(code)) return build('card_blocked', input);
  if (/limit/.test(code)) return build('limit_exceeded', input);
  if (/expir/.test(code)) return build('card_expired', input);
  if (/invalid_card|card_invalid|invalid_pan/.test(code)) return build('card_invalid', input);
  if (/otp_required|otp/.test(code) && /req/.test(code)) return build('otp_required', input);
  if (/otp_invalid|wrong_otp/.test(code)) return build('otp_invalid', input);
  if (/unauth|forbidden|invalid_token/.test(code)) return build('auth', input);
  if (/service_unavailable|gateway|timeout/.test(code)) return build('service_unavailable', input);

  // 2) keyword scan over the message
  for (const k of KEYWORDS) {
    if (k.rx.test(msg)) return build(k.cat, input);
  }

  return build('unknown', input);
}

function build(
  cat: PaymentErrorCategory,
  raw: { code?: string | number; message?: string },
): PaymentErrorMapped {
  const t = TITLES[cat];
  return { category: cat, title: t.title, hint: t.hint, raw };
}
