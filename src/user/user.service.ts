import { 
  Injectable, 
  BadRequestException, 
  UnauthorizedException, 
  NotFoundException, 
  InternalServerErrorException, 
  ForbiddenException,
  Logger
  } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User, UserRole } from './entities/user.entity';
import { 
  SendOtpDto, 
  CompleteRegisterDto,
  LoginDto, 
  VerifyOtpDto,
  ResetPasswordDto, 
  ForgotPasswordDto 
  } from './dto/create-user.dto';
import {UpdateUserDto} from './dto/update-user.dto'
import { SelfUpdateUserDto } from './dto/self-update-user.dto'
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import axios from 'axios';
import dotenv from 'dotenv';
import { AdminCreateDto } from './dto/create-admin.dto';
import { SmsService } from './send.sms.service';
import { verifyTelegramInitData } from '../auth/telegram-init-data';
import { UserDevice } from './entities/user-device.entity';
import { randomUUID, randomBytes, createHash } from 'crypto';

/** Refresh token muddati — 30 kun. Standart mobile-app default'i:
 *  uzoq refresh + qisqa access. Rotation har refresh paytida ishlaydi
 *  (eski hash o'chiriladi, yangi yoziladi). */
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Logout blacklist TTL — access token muddatiga teng (15 min). Eski
 *  hardcoded 86400 (1d) endi joriy emas. */
const ACCESS_TOKEN_BLACKLIST_TTL_S = 15 * 60;

/**
 * Session yaratish uchun device context — login yo'lidan yuboriladi.
 * Hammasi optional: hech qanday qurilma metadata bo'lmasa ham session
 * yaratiladi, faqat sessionId asosida bog'lanadi.
 */
export interface SessionContext {
  fingerprint?: string;
  ipAddress?: string;
  userAgent?: string | null;
  model?: string;
  os?: string;
  osVersion?: string;
  appVersion?: string;
}

dotenv.config();

@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name);
  constructor(
    @InjectRedis() private readonly redis: Redis,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(UserDevice)
    private readonly deviceRepository: Repository<UserDevice>,
    private jwtService: JwtService,
    private readonly smsService: SmsService,
  ) {}

  // onModuleInit super-admin seed olib tashlandi — `SuperAdminSeed`
  // (OnApplicationBootstrap) bitta yagona joy bo'lib qoladi (BUG-A03).
  // Avval ikkita seeder yonma-yon ishlardi va har biri o'z fallback
  // ishlatardi.

  async findByRole(role: UserRole) {
    return this.userRepository.find({ where: { role } });
  }

  private normalizePhone(input: string): string {
    let digits = (input || '').replace(/\D/g, '');
    if (digits.startsWith('998')) digits = digits.slice(3);
    if (digits.length !== 9) {
      throw new BadRequestException("Telefon raqami noto'g'ri formatda");
    }
    return '+998' + digits;
  }

  private async assertOtpRateLimit(phone: string, kind: 'register' | 'reset') {
    const minuteKey = `otp_rl:${kind}:1m:${phone}`;
    const minuteCount = await this.redis.incr(minuteKey);
    if (minuteCount === 1) await this.redis.expire(minuteKey, 60);
    if (minuteCount > 1) {
      throw new BadRequestException("Iltimos 1 daqiqadan so'ng qaytadan urinib ko'ring");
    }

    const hourKey = `otp_rl:${kind}:1h:${phone}`;
    const hourCount = await this.redis.incr(hourKey);
    if (hourCount === 1) await this.redis.expire(hourKey, 3600);
    if (hourCount > 5) {
      throw new BadRequestException("Soatlik limit tugadi. 1 soatdan keyin urinib ko'ring");
    }
  }

async sendOtp(dto: SendOtpDto) {
  const phone = this.normalizePhone(dto.phoneNumber);

  const existingUser = await this.userRepository.findOneBy({ phoneNumber: phone });
  if (existingUser) {
    throw new BadRequestException("Bu telefon raqami allaqachon ro'yxatdan o'tgan!");
  }

  await this.assertOtpRateLimit(phone, 'register');

  const otp = Math.floor(1000 + Math.random() * 9000).toString();
  await this.redis.set(`otp:${phone}`, otp, 'EX', 300);

  void this.smsService
    .send(
      phone,
      `ESCRO platformasida ro'yxatdan o'tish uchun tasdiqlash kodi: ${otp}. Kodni hech kimga bermang.`,
    )
    .catch(async (error) => {
      this.logger.error(`OTP SMS muvaffaqiyatsiz (${phone}): ${(error as Error).message}`);
      await this.redis.del(`otp:${phone}`);
    });

  return { message: "Tasdiqlash kodi yuborildi." };
}

async forgotPassword(dto: ForgotPasswordDto) {
  const phone = this.normalizePhone(dto.phoneNumber);

  const user = await this.userRepository.findOneBy({ phoneNumber: phone });
  if (!user) throw new NotFoundException("Foydalanuvchi topilmadi");

  await this.assertOtpRateLimit(phone, 'reset');

  const otp = Math.floor(1000 + Math.random() * 9000).toString();
  await this.redis.set(`reset_otp:${phone}`, otp, 'EX', 300);

  void this.smsService
    .send(
      phone,
      `ESCRO platformasida ro'yxatdan o'tish uchun tasdiqlash kodi: ${otp}. Kodni hech kimga bermang.`,
    )
    .catch(async (error) => {
      this.logger.error(`Reset OTP SMS muvaffaqiyatsiz (${phone}): ${(error as Error).message}`);
      await this.redis.del(`reset_otp:${phone}`);
    });

  return { message: "Parolni tiklash kodi yuborildi." };
}

async verifyOtp(dto: VerifyOtpDto) {
  const phone = this.normalizePhone(dto.phoneNumber);
  // BUG-L15: OTP brute-force himoyasi. 4-raqamli OTP + 5 daqiqalik TTL +
  // 30/min throttle = ~150 urinish = 1.5% chance per cycle. Endi:
  // 5 ta noto'g'ri kiritishdan keyin OTP o'chiriladi va telefon 15 daqiqa
  // bloklanadi (login_fail bilan bir xil pattern).
  const failKey = `otp_fail:${phone}`;
  const failCount = Number((await this.redis.get(failKey)) ?? 0);
  if (failCount >= 5) {
    const ttl = await this.redis.ttl(failKey);
    const minutes = Math.max(1, Math.ceil((ttl > 0 ? ttl : 900) / 60));
    throw new BadRequestException(
      `Juda ko'p urinish. ${minutes} daqiqadan keyin qaytadan urinib ko'ring.`,
    );
  }

  const savedCode = await this.redis.get(`otp:${phone}`);
  if (!savedCode || savedCode !== dto.code) {
    const next = await this.redis.incr(failKey);
    if (next === 1) await this.redis.expire(failKey, 900);
    if (next >= 5) {
      // OTP bloklash bilan birga eski OTP'ni ham bekor qilamiz
      await this.redis.del(`otp:${phone}`);
    }
    throw new BadRequestException("Kod noto'g'ri yoki muddati o'tgan");
  }

  await this.redis.set(`verified:${phone}`, 'true', 'EX', 600);
  await this.redis.del(`otp:${phone}`);
  await this.redis.del(failKey);

  return { message: "Kod tasdiqlandi, endi ma'lumotlaringizni kiriting" };
}

  // 2. Register (Kodni tekshirish va parolni saqlash)
  async completeRegister(dto: CompleteRegisterDto) {
  const phone = this.normalizePhone(dto.phoneNumber);

  const isVerified = await this.redis.get(`verified:${phone}`);
  if (!isVerified) {
    throw new BadRequestException("Avval telefon raqamingizni tasdiqlang");
  }

  const hashedPassword = await bcrypt.hash(dto.password, 10);

  let user = await this.userRepository.findOneBy({ phoneNumber: phone });
  if (!user) {
    user = this.userRepository.create({ phoneNumber: phone });
  }

  user.fullName = dto.fullName;
  user.password = hashedPassword;
  user.isVerified = true;

  const saved = await this.userRepository.save(user);
  await this.redis.del(`verified:${phone}`);

  return {
    message: "Muvaffaqiyatli ro'yxatdan o'tdingiz",
    user: {
      id: saved.id,
      fullName: saved.fullName,
      phoneNumber: saved.phoneNumber,
      role: saved.role,
    },
  };
}

  // 3. Login (Parolni tekshirish)
  async login(dto: LoginDto, deviceCtx?: SessionContext) {
  const phone = this.normalizePhone(dto.phoneNumber);
  const failKey = `login_fail:${phone}`;

  // Bruteforce check: 5 failed attempts within 15 minutes locks the
  // account; the counter clears automatically when the window expires.
  const fails = Number(await this.redis.get(failKey)) || 0;
  if (fails >= 5) {
    const ttl = await this.redis.ttl(failKey);
    const minutes = Math.max(1, Math.ceil((ttl > 0 ? ttl : 900) / 60));
    throw new UnauthorizedException(
      `Hisob ${minutes} daqiqaga vaqtincha bloklandi. Keyinroq urinib ko'ring.`,
    );
  }

  const user = await this.userRepository.createQueryBuilder("user")
    .addSelect("user.password")
    .where("user.phoneNumber = :phone", { phone })
    .getOne();
  if (!user || !user.isVerified) {
    await this.recordLoginFailure(failKey);
    throw new UnauthorizedException("Foydalanuvchi topilmadi yoki tasdiqlanmagan");
  }

  const isMatch = await bcrypt.compare(dto.password, user.password);
  if (!isMatch) {
    await this.recordLoginFailure(failKey);
    throw new UnauthorizedException("Telefon raqami yoki parol noto'g'ri");
  }

  // Successful login — drop the counter.
  await this.redis.del(failKey).catch(() => undefined);

  return this.issueAuth(user, deviceCtx);
}

  private async recordLoginFailure(key: string): Promise<void> {
    const next = await this.redis.incr(key);
    if (next === 1) {
      await this.redis.expire(key, 900); // 15 min lockout window
    }
  }

  /**
   * Refresh token uchun yangi tasodifiy qiymat yaratish. Plain qiymat
   * faqat shu joydan qaytadi (clientga yuboriladi); DB'ga faqat SHA-256
   * hash yoziladi. Shu sababli token o'g'irlangan bo'lsa ham, DB dump
   * orqali boshqa user'lar refresh'larini tiklab bo'lmaydi.
   */
  private generateRefreshToken(): { plain: string; hash: string } {
    const plain = randomBytes(48).toString('base64url');
    const hash = createHash('sha256').update(plain).digest('hex');
    return { plain, hash };
  }

  /** Plain refresh token'ni DB'dagi hash bilan solishtirish uchun. */
  private hashRefreshToken(plain: string): string {
    return createHash('sha256').update(plain).digest('hex');
  }

  /**
   * Yangi sessiya yaratib access + refresh token chiqaradi. Har login
   * alohida UserDevice qatori bo'lib yoziladi va JWT payload'da `sid`
   * shu qatorni identifikatsiya qiladi. Refresh token hash'i shu qatorga
   * yoziladi — `/auth/refresh` endpoint shu hash bilan plain refresh'ni
   * solishtiradi va yangi pair chiqaradi (rotation).
   *
   * Sessiyani rad etish uchun shu qator `revokedAt` to'ldiriladi
   * (admin yoki foydalanuvchining o'zi orqali).
   */
  private async issueAuth(user: User, deviceCtx?: SessionContext) {
    const sessionId = randomUUID();
    const { plain: refreshToken, hash: refreshHash } = this.generateRefreshToken();
    const refreshExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

    try {
      await this.deviceRepository.save(
        this.deviceRepository.create({
          userId: user.id,
          sessionId,
          refreshTokenHash: refreshHash,
          refreshTokenExpiresAt: refreshExpiresAt,
          fingerprint: deviceCtx?.fingerprint || sessionId,
          ipAddress: deviceCtx?.ipAddress ?? undefined,
          userAgent: deviceCtx?.userAgent ?? null,
          model: deviceCtx?.model ?? '',
          os: deviceCtx?.os ?? '',
          osVersion: deviceCtx?.osVersion ?? '',
          appVersion: deviceCtx?.appVersion ?? '',
        }),
      );
    } catch (e) {
      // Session yozish muvaffaqiyatsiz bo'lsa login ham buziladi —
      // shunchaki log va davom. Token chiqariladi, lekin sid bo'lmaydi
      // va JWT strategy uni rad etadi → fallback re-login.
      this.logger.warn(
        `issueAuth: session insert failed for user ${user.id}: ${(e as Error).message}`,
      );
    }

    const payload: any = {
      sub: user.id,
      tokenVersion: user.tokenVersion ?? 0,
      sid: sessionId,
      phoneNumber: user.phoneNumber,
      fullName: user.fullName,
      role: user.role,
    };
    return {
      access_token: this.jwtService.sign(payload),
      refresh_token: refreshToken,
      refresh_expires_at: refreshExpiresAt.toISOString(),
      user: {
        id: user.id,
        fullName: user.fullName,
        phoneNumber: user.phoneNumber,
        role: user.role,
      },
    };
  }

  /**
   * Refresh token bo'yicha yangi pair chiqarish (rotation).
   * - Plain refresh hash qilinadi va DB'dan UserDevice qidirilad
   * - Muddati o'tgan / revoke qilingan / hech qaysi qatorga to'g'ri
   *   kelmagan refresh rad etiladi
   * - Topilsa: yangi refresh va yangi access token chiqarilad, eski
   *   refresh hash'i DB'dan o'chadi (rotation — eski refresh'ni qayta
   *   ishlatib bo'lmaydi)
   *
   * Eski refresh'ni qayta-qayta ishlatish detection (replay) hozircha
   * yo'q — agar kerak bo'lsa, eski qatorda revokedAt='reused' qo'yamiz
   * va shu user'ning hamma sessiyalarini majburiy yopamiz.
   */
  async refreshTokens(plainRefreshToken: string, deviceCtx?: SessionContext) {
    if (!plainRefreshToken || typeof plainRefreshToken !== 'string') {
      throw new UnauthorizedException('Refresh token yo\'q');
    }
    const hash = this.hashRefreshToken(plainRefreshToken);
    const device = await this.deviceRepository.findOne({
      where: { refreshTokenHash: hash },
    });
    if (!device) {
      throw new UnauthorizedException('Refresh token yaroqsiz');
    }
    if (device.revokedAt) {
      throw new UnauthorizedException('Sessiya bekor qilingan, qaytadan login qiling');
    }
    if (!device.refreshTokenExpiresAt || device.refreshTokenExpiresAt.getTime() < Date.now()) {
      // Muddati o'tgan — DB'dan tozalab tashlaymiz va qayta loginga yo'naltiramiz
      device.refreshTokenHash = null;
      device.refreshTokenExpiresAt = null;
      await this.deviceRepository.save(device);
      throw new UnauthorizedException('Sessiya muddati tugadi, qaytadan login qiling');
    }
    const user = await this.userRepository.findOne({ where: { id: device.userId } });
    if (!user) {
      throw new UnauthorizedException('Foydalanuvchi topilmadi');
    }

    // Rotation: yangi refresh chiqaramiz, eskisini almashtiramiz.
    const { plain: newRefresh, hash: newHash } = this.generateRefreshToken();
    const newExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
    device.refreshTokenHash = newHash;
    device.refreshTokenExpiresAt = newExpiresAt;
    device.lastLogin = new Date();
    // Refresh — yangi launch'ning device headerlari kelsa device qatorini
    // yangilab boramiz (foydalanuvchi telefon nomini, OS versiyani
    // o'zgartirgan bo'lishi mumkin). Bo'sh qiymatlar bilan eskisini bosib
    // o'tib ketmaymiz.
    if (deviceCtx) {
      if (deviceCtx.model) device.model = deviceCtx.model;
      if (deviceCtx.os) device.os = deviceCtx.os;
      if (deviceCtx.osVersion) device.osVersion = deviceCtx.osVersion;
      if (deviceCtx.appVersion) device.appVersion = deviceCtx.appVersion;
      if (deviceCtx.ipAddress) device.ipAddress = deviceCtx.ipAddress;
      if (deviceCtx.userAgent) device.userAgent = deviceCtx.userAgent;
    }
    await this.deviceRepository.save(device);

    const payload: any = {
      sub: user.id,
      tokenVersion: user.tokenVersion ?? 0,
      sid: device.sessionId,
      phoneNumber: user.phoneNumber,
      fullName: user.fullName,
      role: user.role,
    };
    return {
      access_token: this.jwtService.sign(payload),
      refresh_token: newRefresh,
      refresh_expires_at: newExpiresAt.toISOString(),
      user: {
        id: user.id,
        fullName: user.fullName,
        phoneNumber: user.phoneNumber,
        role: user.role,
      },
    };
  }

  /**
   * Foydalanuvchining sessiyalari ro'yxati (faqat o'ziniki yoki admin
   * paneli orqali boshqa user'niki).
   */
  async listSessions(userId: number) {
    return this.deviceRepository.find({
      where: { userId },
      order: { lastLogin: 'DESC' },
      take: 50,
    });
  }

  /**
   * Bitta sessiyani rad etish. Foydalanuvchining o'zi yoki admin
   * chaqirishi mumkin (controller'da auth tekshiriladi).
   */
  async revokeSession(sessionRowId: number, reason: string) {
    const row = await this.deviceRepository.findOne({
      where: { id: sessionRowId },
    });
    if (!row) {
      throw new NotFoundException("Sessiya topilmadi");
    }
    if (row.revokedAt) {
      return { ok: true, alreadyRevoked: true, id: row.id };
    }
    row.revokedAt = new Date();
    row.revokedReason = reason;
    await this.deviceRepository.save(row);
    return { ok: true, id: row.id, revokedAt: row.revokedAt };
  }

  /**
   * Foydalanuvchini barcha qurilmalardan chiqarib yuborish. Admin yoki
   * foydalanuvchining o'zi ("Boshqa joylardan chiqish") chaqiradi.
   * Effekt: shu user'ning barcha sessiyalari + tokenVersion ham +1 (eski
   * tokenlar payload mismatch sababli ham yaroqsiz bo'ladi — defense
   * in depth).
   */
  async forceLogoutUser(userId: number, reason: string) {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException("Foydalanuvchi topilmadi");

    user.tokenVersion = (user.tokenVersion ?? 0) + 1;
    await this.userRepository.save(user);

    const now = new Date();
    const sessions = await this.deviceRepository.find({
      where: { userId, revokedAt: undefined as any },
    });
    for (const s of sessions) {
      if (!s.revokedAt) {
        s.revokedAt = now;
        s.revokedReason = reason;
        // Refresh tokenni ham bekor qilamiz — aks holda foydalanuvchi
        // yangi access olishi mumkin edi rotation orqali.
        s.refreshTokenHash = null;
        s.refreshTokenExpiresAt = null;
      }
    }
    if (sessions.length) await this.deviceRepository.save(sessions);

    return {
      ok: true,
      userId,
      sessionsRevoked: sessions.length,
      newTokenVersion: user.tokenVersion,
    };
  }

  /**
   * Re-issue a JWT for a user identified by their Telegram WebApp initData.
   * The frontend calls this on app boot so a returning Mini-App user does not
   * have to re-enter phone+OTP. Throws NotFoundException when the Telegram
   * account has never been linked — the frontend then falls back to phone+OTP
   * and the link is created automatically on the next successful login.
   */
  async loginByTelegram(initData: string, deviceCtx?: SessionContext) {
    const botToken = process.env.TG_BOT_TOKEN;
    if (!botToken) {
      throw new InternalServerErrorException('TG_BOT_TOKEN sozlanmagan');
    }
    let parsed;
    try {
      parsed = verifyTelegramInitData(initData, botToken);
    } catch (err) {
      throw new BadRequestException(
        `Telegram initData noto'g'ri: ${(err as Error).message}`,
      );
    }
    if (!parsed.user?.id) {
      throw new BadRequestException("initData ichida user.id yo'q");
    }
    const telegramId = String(parsed.user.id);
    const user = await this.userRepository.findOne({
      where: { telegramId, isVerified: true },
    });
    if (!user) {
      throw new NotFoundException('Telegram hisobi hali biriktirilmagan');
    }
    return this.issueAuth(user, deviceCtx);
  }

  /**
   * Best-effort: associate the given Telegram WebApp initData (already
   * verified by the caller, or freshly verified here) with the user, so
   * future Mini-App opens can skip phone+OTP. Errors are swallowed because
   * this runs as a side-effect of the regular login/register flow and must
   * not break the response.
   */
  async linkTelegramFromInitData(userId: number, initData?: string): Promise<void> {
    if (!initData) return;
    const botToken = process.env.TG_BOT_TOKEN;
    if (!botToken) return;
    try {
      const parsed = verifyTelegramInitData(initData, botToken);
      const telegramId = parsed.user?.id ? String(parsed.user.id) : null;
      if (!telegramId) return;
      await this.userRepository.update({ id: userId }, { telegramId });
    } catch (err) {
      this.logger.warn(
        `linkTelegramFromInitData: ${(err as Error).message} (userId=${userId})`,
      );
    }
  }

  /**
   * Logout: access tokenni Redis'ga blacklist'ga qo'yamiz (15 min — access
   * muddatiga teng) va shu sessiya refresh tokenini ham bekor qilamiz
   * (DB'dagi hash'ni tozalaymiz). Shunday qilib eski refresh ham qayta
   * ishlatib bo'lmaydi.
   *
   * `sessionId` JWT payload'dan keladi (`payload.sid`). Pre-sid era
   * tokenlarda yo'q — bunday holatda faqat blacklist ishlaydi.
   */
  async logout(token: string, sessionId?: string | null){
    await this.redis.set(token, 'blacklisted', 'EX', ACCESS_TOKEN_BLACKLIST_TTL_S);
    if (sessionId) {
      try {
        await this.deviceRepository.update(
          { sessionId },
          { refreshTokenHash: null, refreshTokenExpiresAt: null, revokedAt: new Date(), revokedReason: 'logout' },
        );
      } catch (e) {
        this.logger.warn(`logout: revoke session ${sessionId} failed: ${(e as Error).message}`);
      }
    }
    return {message: "Tizimdan muvaqqiyatli chiqildi"};
  };

  async updateProfile(userId: number, dto: SelfUpdateUserDto) {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException("Foydalanuvchi topilmadi");

    // DTO atayin role/phoneNumber/password ni qabul qilmaydi (mass-assignment
    // himoyasi). Faqat profil display maydonlarini yangilaymiz.
    if (dto.fullName !== undefined) user.fullName = dto.fullName.trim();

    return this.userRepository.save(user);
  }

  /** Avatarni o'rnatish/olib tashlash. `filename` null bo'lsa — o'chiriladi.
   *  Serve URL'i `/auth/avatar/file/<name>` shaklida saqlanadi. */
  async setAvatar(userId: number, filename: string | null) {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException("Foydalanuvchi topilmadi");
    user.avatarUrl = filename ? `/auth/avatar/file/${filename}` : null;
    await this.userRepository.save(user);
    return { avatarUrl: user.avatarUrl };
  }

  /** Joriy parolni tekshirib, yangi parolga almashtirish.
   *  tokenVersion +1 — barcha qurilmalardagi eski JWT'lar darhol yaroqsiz.
   *  Yangi token chiqaramiz va qaytaramiz (joriy qurilma chiqib ketmaydi). */
  async changePassword(
    userId: number,
    currentPassword: string,
    newPassword: string,
    deviceCtx?: SessionContext,
  ) {
    if (!currentPassword || !newPassword) {
      throw new BadRequestException('Parollarni kiriting');
    }
    if (newPassword.length < 6) {
      throw new BadRequestException(
        "Yangi parol kamida 6 ta belgi bo'lishi kerak",
      );
    }
    const user = await this.userRepository
      .createQueryBuilder('u')
      .addSelect('u.password')
      .where('u.id = :id', { id: userId })
      .getOne();
    if (!user) throw new NotFoundException('Foydalanuvchi topilmadi');
    const ok = await bcrypt.compare(currentPassword, user.password as any);
    if (!ok) throw new UnauthorizedException("Joriy parol noto'g'ri");
    user.password = await bcrypt.hash(newPassword, 10);
    user.tokenVersion = (user.tokenVersion ?? 0) + 1;
    await this.userRepository.save(user);
    // Parol o'zgardi — barcha eski sessiyalardagi refresh tokenlarni ham
    // tozalaymiz (aks holda o'g'irlangan refresh hali ham yangi access
    // olardi). Yangi `issueAuth` joriy qurilma uchun yangi pair yaratadi.
    await this.deviceRepository
      .createQueryBuilder()
      .update(UserDevice)
      .set({ refreshTokenHash: null, refreshTokenExpiresAt: null })
      .where('userId = :uid', { uid: user.id })
      .execute()
      .catch((e) =>
        this.logger.warn(`changePassword: revoke refresh for user ${user.id} failed: ${(e as Error).message}`),
      );
    // Issue a fresh JWT bound to the new tokenVersion so the current
    // device stays signed in. Other devices (old tokens) get 401 on
    // their next request.
    return this.issueAuth(user, deviceCtx);
  }

  /** Foydalanuvchi sozlamalari (push, jim soatlar, til). */
  async getPreferences(userId: number) {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('Foydalanuvchi topilmadi');
    return {
      pushEnabled: user.pushEnabled,
      notifChat: user.notifChat,
      notifContract: user.notifContract,
      notifPayment: user.notifPayment,
      notifMarketing: user.notifMarketing,
      quietFrom: user.quietFrom ?? null,
      quietTo: user.quietTo ?? null,
      locale: user.locale,
    };
  }

  async updatePreferences(
    userId: number,
    dto: {
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
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('Foydalanuvchi topilmadi');
    const timeOk = (v?: string | null) =>
      v == null || v === '' || /^\d{2}:\d{2}$/.test(v);
    if (!timeOk(dto.quietFrom) || !timeOk(dto.quietTo)) {
      throw new BadRequestException("Jim soatlar formati HH:MM bo'lishi kerak");
    }
    const allowedLocales = new Set(['uz', 'uz-cyr', 'ru', 'en']);
    if (dto.locale && !allowedLocales.has(dto.locale)) {
      throw new BadRequestException('Til tanlovida xatolik');
    }
    if (dto.pushEnabled !== undefined) user.pushEnabled = dto.pushEnabled;
    if (dto.notifChat !== undefined) user.notifChat = dto.notifChat;
    if (dto.notifContract !== undefined) user.notifContract = dto.notifContract;
    if (dto.notifPayment !== undefined) user.notifPayment = dto.notifPayment;
    if (dto.notifMarketing !== undefined)
      user.notifMarketing = dto.notifMarketing;
    if (dto.quietFrom !== undefined)
      user.quietFrom = dto.quietFrom === '' ? null : dto.quietFrom;
    if (dto.quietTo !== undefined)
      user.quietTo = dto.quietTo === '' ? null : dto.quietTo;
    if (dto.locale !== undefined) user.locale = dto.locale;
    await this.userRepository.save(user);
    return this.getPreferences(userId);
  }

async getProfile(userId: number) {
  // Bazadan userni topamiz
  const user = await this.userRepository.findOne({ where: { id: userId } });
  
  if (!user) {
    throw new NotFoundException("Foydalanuvchi topilmadi");
  }

  // Ob'ektdan nusxa olamiz va parolni o'chirib tashlaymiz
  const userResponse = { ...user };
  delete (userResponse as any).password;

  return userResponse;
}

// 2. Kodni tekshirib parolni yangilash
async resetPassword(dto: ResetPasswordDto) {
  const phone = this.normalizePhone(dto.phoneNumber);
  const savedCode = await this.redis.get(`reset_otp:${phone}`);

  if (!savedCode || savedCode !== dto.code) {
    throw new BadRequestException("Kod noto'g'ri yoki muddati o'tgan");
  }

  const user = await this.userRepository.findOneBy({ phoneNumber: phone });
  if (!user) throw new NotFoundException("Foydalanuvchi topilmadi");

  user.password = await bcrypt.hash(dto.newPassword, 10);
  // BUG-L16: tokenVersion'ni inkrement qilish — eski JWT'lar darhol
  // yaroqsiz bo'ladi (kim shubhali tarzda foydalanuvchi sessiyasini
  // o'g'irlagan bo'lsa, parol reset bilan birga chiqarib yuboriladi).
  user.tokenVersion = (user.tokenVersion ?? 0) + 1;
  await this.userRepository.save(user);

  // Parol reset bo'ldi — barcha qurilmalardagi refresh tokenlarni ham
  // bekor qilamiz. Aks holda refresh hali ham yangi access olishi mumkin
  // edi (tokenVersion mos kelmasligi sababli /auth/refresh ichida user
  // qidiruvi dan keyin tekshirish kerak — yoki tezroq: hashni tozalash).
  await this.deviceRepository
    .createQueryBuilder()
    .update(UserDevice)
    .set({ refreshTokenHash: null, refreshTokenExpiresAt: null })
    .where('userId = :uid', { uid: user.id })
    .execute()
    .catch((e) =>
      this.logger.warn(`resetPassword: revoke refresh for user ${user.id} failed: ${(e as Error).message}`),
    );

  await this.redis.del(`reset_otp:${phone}`);

  return { message: "Parolingiz muvaffaqiyatli yangilandi. Endi login qilishingiz mumkin." };
}
// src/user/user.service.ts

async findAll() {
  // BUG-A23: faqat zarur ustunlarni qaytaramiz. Avval butun User row
  // qaytarilardi (otpCode, kycRejectionReason, telegramId — admin
  // dashboard'iga kerak emas).
  return await this.userRepository.find({
    select: [
      'id',
      'fullName',
      'phoneNumber',
      'role',
      'isVerified',
      'kycStatus',
      'createdAt',
    ],
    order: { id: 'DESC' },
    // TODO: pagination — admin/users large datasetlarda sekinlashadi.
    // Hozircha take: 200 cheklov, keyin cursor pagination qo'shamiz.
    take: 200,
  });
}

// src/user/user.service.ts ichiga qo'shing

async createAdmin(dto: AdminCreateDto) { // CreateUserDto emas, AdminCreateDto
  const hashedPassword = await bcrypt.hash(dto.password, 10);
  const newAdmin = this.userRepository.create({
    ...dto,
    password: hashedPassword,
    role: dto.role || UserRole.ADMIN, // Agar DTO'da kelmasa, default ADMIN
    isVerified: true,
  });
  return await this.userRepository.save(newAdmin);
}

async update(id: number, dto: UpdateUserDto) {
  const user = await this.userRepository.findOneBy({ id });
  if (!user) throw new NotFoundException("Foydalanuvchi topilmadi");

  // Parol bo'lsa, uni hashlash kerak (agar tahrirlashda parol yuborilsa)
  if (dto.password) {
    dto.password = await bcrypt.hash(dto.password, 10);
  }

  Object.assign(user, dto);
  return await this.userRepository.save(user);
}

async remove(id: number, admin: any) {
  const user = await this.userRepository.findOneBy({ id });
  if (!user) throw new NotFoundException("Foydalanuvchi topilmadi");

  // HIMOYA: Super adminni hech kim o'chira olmaydi
  if (user.role === UserRole.SUPER_ADMIN) {
    throw new ForbiddenException("Super Adminni tizimdan o'chirib bo'lmaydi!");
  }

  // HIMOYA: Oddiy admin boshqa adminni o'chira olmaydi (faqat Super Admin qila oladi)
  if (user.role === UserRole.ADMIN && admin.role !== UserRole.SUPER_ADMIN) {
    throw new ForbiddenException("Adminlarni faqat Super Admin o'chira oladi!");
  }

  return await this.userRepository.remove(user);
}
}