import { Controller, Post, Body, HttpCode, HttpStatus, UseGuards, Get, Request, Patch, Headers, Delete, Param, ParseIntPipe, Req, UseInterceptors, UploadedFile, Res, BadRequestException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname, join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import type { Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { UserService } from './user.service';
import { SendOtpDto, CompleteRegisterDto, LoginDto, VerifyOtpDto, ForgotPasswordDto, ResetPasswordDto } from './dto/create-user.dto';
import {UpdateUserDto} from './dto/update-user.dto'
import { SelfUpdateUserDto } from './dto/self-update-user.dto'
import { AuthGuard } from '@nestjs/passport'; // Mana shu qatorni qo'shing
import { extractSessionContext } from './session-context.util';

const AVATAR_UPLOAD_DIR = join(process.cwd(), 'uploads', 'avatars');
if (!existsSync(AVATAR_UPLOAD_DIR)) {
  mkdirSync(AVATAR_UPLOAD_DIR, { recursive: true });
}

const avatarMulterOptions = {
  storage: diskStorage({
    destination: AVATAR_UPLOAD_DIR,
    filename: (_req: any, file: Express.Multer.File, cb: any) => {
      const unique =
        Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
      cb(null, `${unique}${extname(file.originalname).toLowerCase()}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req: any, file: Express.Multer.File, cb: any) => {
    const ok = /^image\/(png|jpe?g|gif|webp|heic)$/i.test(file.mimetype);
    if (!ok) {
      return cb(new BadRequestException('Faqat rasm fayllari qabul qilinadi'), false);
    }
    cb(null, true);
  },
};

@Controller('auth') // 'user' emas 'auth' qilish mantiqan to'g'riroq
export class UserController {
  constructor(private readonly userService: UserService) {}

  // 1. SMS yuborish
  @Post('send-otp')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async sendOtp(@Body() sendOtpDto: SendOtpDto) {
    return this.userService.sendOtp(sendOtpDto);
  }

  @Post('verify-otp')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async verifyOtp(@Body() verifyOtpDto: VerifyOtpDto) {
    return this.userService.verifyOtp(verifyOtpDto);
  }

  // 2. Ro'yxatdan o'tishni yakunlash (SMS kod + Parol)
  @Post('register')
  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  async register(
    @Body() completeDto: CompleteRegisterDto,
    @Headers('x-tg-data') tgData?: string,
  ) {
    const result = await this.userService.completeRegister(completeDto);
    if (result?.user?.id && tgData) {
      void this.userService.linkTelegramFromInitData(result.user.id, tgData);
    }
    return result;
  }

  // 3. Login (Telefon + Parol).
  // 30/min IP throttle is just a coarse net — the real bruteforce defence
  // is in user.service.ts (Redis-backed `login_fail:<phone>` counter, 5
  // failures = 15 min lockout). Keeping the IP throttle low caused 429s
  // for users on shared NATs (cafe Wi-Fi, mobile carrier).
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async login(
    @Body() loginDto: LoginDto,
    @Req() req: any,
    @Headers('x-tg-data') tgData?: string,
  ) {
    const result = await this.userService.login(loginDto, extractSessionContext(req));
    if (result?.user?.id && tgData) {
      void this.userService.linkTelegramFromInitData(result.user.id, tgData);
    }
    return result;
  }

  // 3b. Telegram Mini-App auto-login.
  // Returning users skip phone+OTP entirely once their telegramId is linked.
  @Post('telegram')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async loginTelegram(
    @Body() body: { initData: string },
    @Req() req: any,
  ) {
    return this.userService.loginByTelegram(body?.initData, extractSessionContext(req));
  }

  // 3c. Refresh token rotation. Klient access muddati tugagach (15min)
  // shu endpoint'ga refresh token yuboradi va yangi access + refresh
  // pair oladi. Eski refresh shu zahoti yaroqsiz bo'ladi (rotation).
  // Bu endpoint JwtAuthGuard ostida emas — chunki access expire bo'lgan
  // bo'lishi mumkin; refresh tokenning o'zi avtorizatsiyani ta'minlaydi.
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async refresh(
    @Body() body: { refresh_token?: string; refreshToken?: string },
    @Req() req: any,
  ) {
    const token = body?.refresh_token ?? body?.refreshToken ?? '';
    return this.userService.refreshTokens(token, extractSessionContext(req));
  }

  @UseGuards(AuthGuard('jwt'))
 @Get('profile')
async getProfile(@Request() req) {
  return await this.userService.getProfile(req.user.userId);
}

  /** Profil rasmini yuklash (multipart, field `avatar`). */
  @UseGuards(AuthGuard('jwt'))
  @Post('avatar')
  @UseInterceptors(FileInterceptor('avatar', avatarMulterOptions))
  async uploadAvatar(@Request() req: any, @UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('Rasm yuborilmadi');
    return this.userService.setAvatar(req.user.userId, file.filename);
  }

  /** Profil rasmini olib tashlash. */
  @UseGuards(AuthGuard('jwt'))
  @Delete('avatar')
  async removeAvatar(@Request() req: any) {
    return this.userService.setAvatar(req.user.userId, null);
  }

  /** Avatar faylini ko'rsatish — ochiq (rasm maxfiy emas, <img> token yubora
   *  olmaydi). Path-traversal himoyasi bilan. */
  @Get('avatar/file/:fname')
  serveAvatar(@Param('fname') fname: string, @Res() res: Response) {
    if (fname.includes('/') || fname.includes('..')) {
      throw new BadRequestException('Fayl nomi noto‘g‘ri');
    }
    const fp = join(AVATAR_UPLOAD_DIR, fname);
    if (!existsSync(fp)) {
      res.status(404).json({ message: 'Fayl topilmadi' });
      return;
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(fp);
  }

  @UseGuards(AuthGuard('jwt'))
@Post('logout')
async logout(@Request() req) {
  const token = req.headers.authorization.split(' ')[1];
  const sessionId = req.user?.sid;
  // Access token muddatiga teng blacklist TTL (15 min). Refresh token
  // ham shu sessiyada bekor qilinadi.
  return this.userService.logout(token, sessionId);
}

  /** Foydalanuvchining aktiv sessiyalari ro'yxati */
  @UseGuards(AuthGuard('jwt'))
  @Get('sessions')
  async listSessions(@Request() req: any) {
    return this.userService.listSessions(req.user.userId);
  }

  /** Foydalanuvchi o'z sessiyasini yopadi (boshqa qurilmadan chiqish) */
  @UseGuards(AuthGuard('jwt'))
  @Delete('sessions/:id')
  async revokeOwnSession(
    @Request() req: any,
    @Param('id', ParseIntPipe) id: number,
  ) {
    // Faqat o'zining sessiyasi bo'lsa rad eta oladi
    const sessions = await this.userService.listSessions(req.user.userId);
    const own = sessions.find((s) => s.id === id);
    if (!own) {
      // 404 — IDOR safe (sessiya boshqasiniki bo'lsa ham mavjud emas deb ko'rsatamiz)
      return { ok: false, error: 'Sessiya topilmadi' };
    }
    return this.userService.revokeSession(id, 'user-self');
  }
/** Joriy foydalanuvchining sozlamalarini o'qish */
@UseGuards(AuthGuard('jwt'))
@Get('preferences')
async getPrefs(@Request() req: any) {
  return this.userService.getPreferences(req.user.userId);
}

/** Sozlamalarni yangilash — push toggle'lari, til, jim soatlar */
@UseGuards(AuthGuard('jwt'))
@Patch('preferences')
async updatePrefs(
  @Request() req: any,
  @Body() dto: {
    pushEnabled?: boolean;
    notifChat?: boolean;
    notifContract?: boolean;
    notifPayment?: boolean;
    notifMarketing?: boolean;
    quietFrom?: string | null;
    quietTo?: string | null;
    locale?: string;
  },
) {
  return this.userService.updatePreferences(req.user.userId, dto);
}

/** Joriy parol bilan yangi parolga almashtirish */
@UseGuards(AuthGuard('jwt'))
@Patch('password')
@HttpCode(HttpStatus.OK)
async changePassword(
  @Request() req: any,
  @Body() dto: { currentPassword?: string; newPassword?: string },
) {
  return this.userService.changePassword(
    req.user.userId,
    dto?.currentPassword ?? '',
    dto?.newPassword ?? '',
    extractSessionContext(req),
  );
}

@UseGuards(AuthGuard('jwt'))
@Patch('update-profile') // Patch - qisman yangilash uchun ishlatiladi
async updateProfile(@Request() req, @Body() dto: SelfUpdateUserDto) {
  // req.user ichida JwtStrategy'dan qaytgan userId bo'ladi.
  // DTO atayin self-update uchun cheklangan — role / phoneNumber /
  // password bu yerda qabul qilinmaydi (privilege escalation va
  // identity hijack risklarini bartaraf etish uchun).
  return this.userService.updateProfile(req.user.userId, dto);
}
@Post('forgot-password')
@HttpCode(HttpStatus.OK)
@Throttle({ default: { limit: 5, ttl: 60_000 } })
async forgotPassword(@Body() dto: ForgotPasswordDto) {
  return this.userService.forgotPassword(dto);
}

@Post('reset-password')
@HttpCode(HttpStatus.OK)
@Throttle({ default: { limit: 15, ttl: 60_000 } })
async resetPassword(@Body() dto: ResetPasswordDto) {
  return this.userService.resetPassword(dto);
}
}