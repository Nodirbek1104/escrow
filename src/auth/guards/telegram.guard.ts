import { CanActivate, ExecutionContext, Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import * as crypto from 'crypto';

@Injectable()
export class TelegramGuard implements CanActivate {
  private readonly logger = new Logger(TelegramGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const tgData = request.headers['x-tg-data'];

    // Agar dev rejimida bo'lsak va header bo'lmasa, o'tkazib yuborish (ixtiyoriy)
    if (process.env.NODE_ENV === 'development' && !tgData) {
      return true;
    }

    if (!tgData) {
      throw new UnauthorizedException('Telegram maʼlumotlari topilmadi (Missing x-tg-data)');
    }

    if (!this.validate(tgData)) {
      throw new UnauthorizedException('Telegram maʼlumotlari haqiqiy emas (Invalid Telegram Hash)');
    }

    return true;
  }

  private validate(data: string): boolean {
    const botToken = process.env.TG_BOT_TOKEN;
    if (!botToken) {
      this.logger.error('TG_BOT_TOKEN topilmadi! .env faylini tekshiring.');
      return false;
    }

    try {
      const urlParams = new URLSearchParams(data);
      const hash = urlParams.get('hash');
      urlParams.delete('hash');

      const dataCheckString = Array.from(urlParams.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}=${value}`)
        .join('\n');

      const secretKey = crypto
        .createHmac('sha256', 'WebAppData')
        .update(botToken)
        .digest();

      const calculatedHash = crypto
        .createHmac('sha256', secretKey)
        .update(dataCheckString)
        .digest('hex');

      return calculatedHash === hash;
    } catch (e) {
      this.logger.error(`Validation error: ${e.message}`);
      return false;
    }
  }
}
