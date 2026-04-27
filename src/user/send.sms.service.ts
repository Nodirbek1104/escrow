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

  private async getEskizToken(): Promise<string> {
    const cached = await this.redis.get('eskiz_token');
    if (cached) return cached;

    const response = await axios.post(
      'https://notify.eskiz.uz/api/auth/login',
      {
        email: process.env.ESKIZ_EMAIL,
        password: process.env.ESKIZ_SECRET,
      },
      { timeout: 5000 },
    );

    const token = response.data.data.token;
    await this.redis.set('eskiz_token', token, 'EX', 25 * 24 * 60 * 60);
    return token;
  }

  async send(phoneNumber: string, message: string): Promise<void> {
    try {
      const token = await this.getEskizToken();
      const cleanPhone = phoneNumber.replace(/\D/g, '');

      await axios.post(
        'https://notify.eskiz.uz/api/message/sms/send',
        {
          mobile_phone: cleanPhone,
          message,
          from: process.env.ESKIZ_FROM || '4546',
        },
        { headers: { Authorization: `Bearer ${token}` } },
      );
    } catch (error) {
      this.logger.error(`Eskiz SMS xatosi: ${error}`);
      // throw qilmaymiz — SMS ketmasa ham oqim davom etsin
    }
  }
}