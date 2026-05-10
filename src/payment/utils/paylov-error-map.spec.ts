import { mapPaylovError } from './paylov-error-map';

describe('mapPaylovError', () => {
  it('maps insufficient funds by code', () => {
    expect(mapPaylovError({ code: 'insufficient_funds' }).category).toBe(
      'insufficient_funds',
    );
    expect(
      mapPaylovError({ code: 'NOT_ENOUGH_FUNDS', message: '' }).category,
    ).toBe('insufficient_funds');
  });

  it('maps blocked card', () => {
    expect(mapPaylovError({ code: 'CARD_BLOCKED' }).category).toBe(
      'card_blocked',
    );
    expect(
      mapPaylovError({ message: 'Карта заблокирована' }).category,
    ).toBe('card_blocked');
  });

  it('maps expired card', () => {
    expect(mapPaylovError({ code: 'CARD_EXPIRED' }).category).toBe(
      'card_expired',
    );
    expect(mapPaylovError({ message: 'card expired' }).category).toBe(
      'card_expired',
    );
  });

  it('maps invalid card', () => {
    expect(
      mapPaylovError({ code: 'invalid_card' }).category,
    ).toBe('card_invalid');
  });

  it('maps daily limit exceeded', () => {
    expect(
      mapPaylovError({ code: 'DAILY_LIMIT_EXCEEDED' }).category,
    ).toBe('limit_exceeded');
    expect(
      mapPaylovError({ message: 'monthly limit exceeded' }).category,
    ).toBe('limit_exceeded');
  });

  it('maps OTP categories from message', () => {
    // "tasdiqlash kodi" matches the 'otp_required' regex first.
    expect(
      mapPaylovError({ message: 'tasdiqlash kodi yuborildi' }).category,
    ).toBe('otp_required');
    expect(
      mapPaylovError({ message: 'wrong otp code' }).category,
    ).toBe('otp_invalid');
  });

  it('maps service unavailable / network errors', () => {
    expect(
      mapPaylovError({ message: 'ECONNREFUSED' }).category,
    ).toBe('service_unavailable');
    expect(
      mapPaylovError({ code: 'GATEWAY_TIMEOUT' }).category,
    ).toBe('service_unavailable');
  });

  it('falls back to "unknown" with a default title', () => {
    const r = mapPaylovError({ message: 'some weird thing' });
    expect(r.category).toBe('unknown');
    expect(r.title).toMatch(/amalga oshmadi/i);
    expect(r.hint).toBeTruthy();
  });

  it('always returns title + hint + raw', () => {
    const r = mapPaylovError({ code: 'insufficient_funds', message: 'foo' });
    expect(r.title).toBeTruthy();
    expect(r.hint).toBeTruthy();
    expect(r.raw.code).toBe('insufficient_funds');
    expect(r.raw.message).toBe('foo');
  });
});
