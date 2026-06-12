import { CanActivate, ExecutionContext, Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport'; // 1. Passport JWT himoyachisini olib kirdik
import * as crypto from 'crypto';

@Injectable()
// 2. Klasni faqat oddiy guard emas, AuthGuard('jwt') dan voris qilib oldik
export class TelegramGuard extends AuthGuard('jwt') implements CanActivate {
  private readonly logger = new Logger(TelegramGuard.name);

  // 3. Metod async (asinxron) holatga o'tkazildi, chunki JWT tekshiruvi vaqt talab qiladi
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const tgData = request.headers['x-tg-data'];
    const authHeader = request.headers['authorization']; // Brauzerdan keladigan "Bearer token"

    // [ESKI MANTIQ]: Agar dev rejimida bo'lsak va hech narsa kelmasa, o'tkazib yuborish
    if (process.env.NODE_ENV === 'development' && !tgData && !authHeader) {
      return true;
    }

    // 1-YO'LAK: Agar so'rov Telegram bot (Mini App) ichidan kelayotgan bo'lsa
    if (tgData) {
      if (!this.validate(tgData)) {
        throw new UnauthorizedException('Telegram maʼlumotlari haqiqiy emas (Invalid Telegram Hash)');
      }
      return true; // Telegram tekshiruvi muvaffaqiyatli tugadi, controllerga ruxsat!
    }

    // 2-YO'LAK: Agar Safari/Chrome brauzeridan kelyotgan bo'lsa (Authorization headeri bor)
    if (authHeader) {
      try {
        // Bu joyi NestJS'ning o'zidagi JwtStrategy (jwt.strategy.ts) faylini ishga tushiradi
        const isValidJwt = (await super.canActivate(context)) as boolean;
        return isValidJwt; 
      } catch (error) {
        // Agar token muddati o'tgan yoki xato bo'lsa, xatolik qaytaradi
        throw new UnauthorizedException('Sessiya vaqti tugadi yoki token xato. Iltimos qayta login qiling.');
      }
    }

    // 3-HOLAT: Agar na Telegram headeri va na JWT token kelmagan bo'lsa
    throw new UnauthorizedException('Tizimga kirish uchun ruxsatnoma topilmadi (Missing Auth Credentials)');
  }

  // Telegram ma'lumotlarini tekshiradigan matematik qism o'zgarishsiz qoladi
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