import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import axios from 'axios';

const ESKIZ_BASE = 'https://notify.eskiz.uz';
const REDIS_TOKEN_KEY = 'eskiz_token';
const REDIS_TOKEN_TTL_SECONDS = 29 * 24 * 60 * 60;
const HTTP_TIMEOUT_MS = 10_000;

interface MemToken {
  value: string;
  expiresAt: number;
}

@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);
  private memToken?: MemToken;

  constructor(
    @InjectRedis() private readonly redis: Redis,
  ) {}

  private async getEskizToken(forceRefresh = false): Promise<string> {
    const now = Date.now();

    if (!forceRefresh && this.memToken && this.memToken.expiresAt > now) {
      return this.memToken.value;
    }

    if (!forceRefresh) {
      const cached = await this.redis.get(REDIS_TOKEN_KEY);
      if (cached) {
        this.memToken = {
          value: cached,
          expiresAt: now + 60 * 60 * 1000,
        };
        return cached;
      }
    }

    const email = process.env.ESKIZ_EMAIL;
    const password = process.env.ESKIZ_SECRET;
    if (!email || !password) {
      throw new InternalServerErrorException('Eskiz credentials .env da topilmadi');
    }

    const t0 = Date.now();
    const response = await axios.post(
      `${ESKIZ_BASE}/api/auth/login`,
      { email, password },
      { timeout: HTTP_TIMEOUT_MS },
    );
    const ms = Date.now() - t0;

    const token = response.data?.data?.token;
    if (!token) {
      throw new InternalServerErrorException(
        `Eskiz token olinmadi: ${JSON.stringify(response.data)}`,
      );
    }

    await this.redis.set(REDIS_TOKEN_KEY, token, 'EX', REDIS_TOKEN_TTL_SECONDS);
    this.memToken = {
      value: token,
      expiresAt: now + 60 * 60 * 1000,
    };
    this.logger.log(`Eskiz auth: yangi token olindi (${ms}ms)`);
    return token;
  }

  async send(phoneNumber: string, message: string, retry = true): Promise<void> {
    const cleanPhone = phoneNumber.replace(/\D/g, '');
    const t0 = Date.now();
    try {
      const token = await this.getEskizToken();

      const response = await axios.post(
        `${ESKIZ_BASE}/api/message/sms/send`,
        {
          mobile_phone: cleanPhone,
          message,
          from: process.env.ESKIZ_FROM || '4546',
        },
        {
          headers: { Authorization: `Bearer ${token}` },
          timeout: HTTP_TIMEOUT_MS,
        },
      );

      const status = String(response.data?.status ?? '').toLowerCase();
      if (status === 'error' || status === 'fail' || status === 'failed') {
        const detail = response.data?.message ?? JSON.stringify(response.data);
        throw new InternalServerErrorException(`Eskiz rad etdi: ${detail}`);
      }

      const ms = Date.now() - t0;
      this.logger.log(`Eskiz SMS yuborildi (${cleanPhone}, ${ms}ms, status=${response.data?.status ?? 'unknown'})`);
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 401 && retry) {
        this.logger.warn('Eskiz 401 — token yangilanmoqda, qayta urinaman');
        this.memToken = undefined;
        await this.redis.del(REDIS_TOKEN_KEY);
        return this.send(phoneNumber, message, false);
      }
      const detail = axios.isAxiosError(error)
        ? JSON.stringify(error.response?.data || error.message)
        : (error as Error).message;
      this.logger.error(`Eskiz SMS xatosi (${cleanPhone}, ${Date.now() - t0}ms): ${detail}`);
      if (error instanceof InternalServerErrorException) throw error;
      throw new InternalServerErrorException('SMS yuborilmadi, keyinroq qaytadan urinib ko\'ring');
    }
  }

  /**
   * Fire-and-forget. Caller'ni bloklamaydi, xatolarni faqat log'ga yozadi.
   * OTP uchun ishlatmang — OTP'da chaqiruvchi yetkazilganligini bilishi kerak.
   * Bildirishnoma SMS'lari uchun (yangi shartnoma, nizo va h.k.) ishlating.
   */
  sendInBackground(phoneNumber: string, message: string): void {
    void this.send(phoneNumber, message).catch((error) => {
      this.logger.error(
        `Background SMS muvaffaqiyatsiz (${phoneNumber}): ${
          (error as Error).message
        }`,
      );
    });
  }
}
