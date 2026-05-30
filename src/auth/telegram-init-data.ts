import { createHmac, timingSafeEqual } from 'crypto';

export interface TelegramInitDataUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
  photo_url?: string;
}

export interface TelegramInitData {
  user?: TelegramInitDataUser;
  query_id?: string;
  auth_date: number;
  hash: string;
  start_param?: string;
}

/**
 * Verify a Telegram WebApp initData string and return the decoded payload.
 *
 * Implements https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app:
 *   secret_key = HMAC_SHA256("WebAppData", bot_token)
 *   expected_hash = HMAC_SHA256(data_check_string, secret_key)
 *
 * Throws if the hash is missing/invalid or auth_date is older than maxAgeSec.
 */
export function verifyTelegramInitData(
  initData: string,
  botToken: string,
  maxAgeSec = 86_400,
): TelegramInitData {
  if (!initData || !botToken) {
    throw new Error('initData yoki bot_token bo\'sh');
  }

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) throw new Error('initData hash yo\'q');
  params.delete('hash');

  const pairs: string[] = [];
  Array.from(params.keys())
    .sort()
    .forEach((key) => {
      pairs.push(`${key}=${params.get(key)}`);
    });
  const dataCheckString = pairs.join('\n');

  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expectedHash = createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  const a = Buffer.from(expectedHash, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error('initData hash noto\'g\'ri');
  }

  const authDate = Number(params.get('auth_date') ?? 0);
  if (!authDate) throw new Error('initData auth_date yo\'q');
  const ageSec = Math.floor(Date.now() / 1000) - authDate;
  if (ageSec > maxAgeSec) {
    throw new Error('initData eskirgan');
  }

  let user: TelegramInitDataUser | undefined;
  const userRaw = params.get('user');
  if (userRaw) {
    try {
      user = JSON.parse(userRaw) as TelegramInitDataUser;
    } catch {
      throw new Error('initData user JSON noto\'g\'ri');
    }
  }

  return {
    user,
    query_id: params.get('query_id') ?? undefined,
    auth_date: authDate,
    hash,
    start_param: params.get('start_param') ?? undefined,
  };
}
