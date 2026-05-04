import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import axios from 'axios';

@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);

  constructor(
    @InjectRedis() private readonly redis: Redis,
  ) {}

  private async getEskizToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh) {
      const cached = await this.redis.get('eskiz_token');
      if (cached) return cached;
    }

    const email = process.env.ESKIZ_EMAIL;
    const password = process.env.ESKIZ_SECRET;
    if (!email || !password) {
      throw new InternalServerErrorException('Eskiz credentials .env da topilmadi');
    }

    const response = await axios.post(
      'https://notify.eskiz.uz/api/auth/login',
      { email, password },
      { timeout: 10000 },
    );

    const token = response.data?.data?.token;
    if (!token) {
      throw new InternalServerErrorException('Eskiz token olinmadi');
    }
    await this.redis.set('eskiz_token', token, 'EX', 25 * 24 * 60 * 60);
    return token;
  }

  async send(phoneNumber: string, message: string, retry = true): Promise<void> {
    const cleanPhone = phoneNumber.replace(/\D/g, '');
    try {
      const token = await this.getEskizToken();

      await axios.post(
        'https://notify.eskiz.uz/api/message/sms/send',
        {
          mobile_phone: cleanPhone,
          message,
          from: process.env.ESKIZ_FROM || '4546',
        },
        {
          headers: { Authorization: `Bearer ${token}` },
          timeout: 10000,
        },
      );
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 401 && retry) {
        this.logger.warn('Eskiz token eskirgan, yangilanmoqda');
        await this.redis.del('eskiz_token');
        return this.send(phoneNumber, message, false);
      }
      const detail = axios.isAxiosError(error)
        ? JSON.stringify(error.response?.data || error.message)
        : (error as Error).message;
      this.logger.error(`Eskiz SMS xatosi (${cleanPhone}): ${detail}`);
      throw new InternalServerErrorException('SMS yuborilmadi, keyinroq qaytadan urinib ko\'ring');
    }
  }
}
