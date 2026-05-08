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
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import axios from 'axios';
import dotenv from 'dotenv';
import { AdminCreateDto } from './dto/create-admin.dto';
import { SmsService } from './send.sms.service';
import { verifyTelegramInitData } from '../auth/telegram-init-data';

dotenv.config();

@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name);
  constructor(
    @InjectRedis() private readonly redis: Redis,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    private jwtService: JwtService,
    private readonly smsService: SmsService,
  ) {}

  async onModuleInit() {
    await this.createInitialSuperAdmin();
  }

  private async createInitialSuperAdmin() {
    const superAdminPhone = process.env.SUPER_ADMIN_PHONE;
    const superAdminPass = process.env.SUPER_ADMIN_PASSWORD;

    if (!superAdminPhone || !superAdminPass) {
      console.warn('⚠️ Super Admin maʼlumotlari .env faylda topilmadi!');
      return;
    }

    // Bazada Super Admin bor-yo'qligini tekshiramiz
    const adminExists = await this.userRepository.findOne({ 
      where: { role: UserRole.SUPER_ADMIN } 
    });

    if (!adminExists) {
      const hashedPassword = await bcrypt.hash(superAdminPass, 10);

      const superAdmin = this.userRepository.create({
        phoneNumber: this.normalizePhone(superAdminPhone),
        fullName: 'Asosiy Super Admin',
        password: hashedPassword,
        role: UserRole.SUPER_ADMIN,
        isVerified: true,
      });

      await this.userRepository.save(superAdmin);
      console.log('✅ Super Admin muvaffaqiyatli yaratildi!');
    }
  }

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
  const savedCode = await this.redis.get(`otp:${phone}`);

  if (!savedCode || savedCode !== dto.code) {
    throw new BadRequestException("Kod noto'g'ri yoki muddati o'tgan");
  }

  await this.redis.set(`verified:${phone}`, 'true', 'EX', 600);
  await this.redis.del(`otp:${phone}`);

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
  async login(dto: LoginDto) {
  const phone = this.normalizePhone(dto.phoneNumber);
  const user = await this.userRepository.createQueryBuilder("user")
    .addSelect("user.password")
    .where("user.phoneNumber = :phone", { phone })
    .getOne();
  if (!user || !user.isVerified) {
    throw new UnauthorizedException("Foydalanuvchi topilmadi yoki tasdiqlanmagan");
  }

  const isMatch = await bcrypt.compare(dto.password, user.password);
  if (!isMatch) {
    throw new UnauthorizedException("Telefon raqami yoki parol noto'g'ri");
  }

  return this.issueAuth(user);
}

  private issueAuth(user: User) {
    const payload = {
      sub: user.id,
      phoneNumber: user.phoneNumber,
      fullName: user.fullName,
      role: user.role,
    };
    return {
      access_token: this.jwtService.sign(payload),
      user: {
        id: user.id,
        fullName: user.fullName,
        phoneNumber: user.phoneNumber,
        role: user.role,
      },
    };
  }

  /**
   * Re-issue a JWT for a user identified by their Telegram WebApp initData.
   * The frontend calls this on app boot so a returning Mini-App user does not
   * have to re-enter phone+OTP. Throws NotFoundException when the Telegram
   * account has never been linked — the frontend then falls back to phone+OTP
   * and the link is created automatically on the next successful login.
   */
  async loginByTelegram(initData: string) {
    const botToken = process.env.TG_BOT_TOKEN;
    if (!botToken) {
      throw new InternalServerErrorException('TG_BOT_TOKEN sozlanmagan');
    }
    const parsed = verifyTelegramInitData(initData, botToken);
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
    return this.issueAuth(user);
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

  async logout(token: string, expiresIn){
    await this.redis.set(token, 'blacklisted', 'EX', expiresIn);
    return {message: "Tizimdan muvaqqiyatli chiqildi"};
  };

  async updateProfile(userId: number, dto: UpdateUserDto) {
  const user = await this.userRepository.findOne({ where: { id: userId } });
  if (!user) throw new NotFoundException("Foydalanuvchi topilmadi");

    if (dto.password) {
    dto.password = await bcrypt.hash(dto.password, 10);
  }
  // Yangi ma'lumotlarni eski ma'lumotlar ustiga yozamiz
  Object.assign(user, dto);
  
  return this.userRepository.save(user);
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
  await this.userRepository.save(user);

  await this.redis.del(`reset_otp:${phone}`);

  return { message: "Parolingiz muvaffaqiyatli yangilandi. Endi login qilishingiz mumkin." };
}
// src/user/user.service.ts

async findAll() {
  return await this.userRepository.find({
    order: { id: 'DESC' } // Yangi qo'shilganlar tepada chiqadi
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