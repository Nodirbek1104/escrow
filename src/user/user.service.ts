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
        phoneNumber: superAdminPhone,
        fullName: 'Asosiy Super Admin',
        password: hashedPassword,
        role: UserRole.SUPER_ADMIN,
        isVerified: true,
      });

      await this.userRepository.save(superAdmin);
      console.log('✅ Super Admin muvaffaqiyatli yaratildi!');
    }
  }


async sendOtp(dto: SendOtpDto) {
  // 1. Avval foydalanuvchi borligini tekshiramiz (Vaqtni tejash uchun)
  const existingUser = await this.userRepository.findOneBy({ phoneNumber: dto.phoneNumber });
  if (existingUser) {
    throw new BadRequestException("Bu telefon raqami allaqachon ro'yxatdan o'tgan!");
  }

  const otp = Math.floor(1000 + Math.random() * 9000).toString();

  // 2. Kodni terminalga darhol chiqarish (Hamma narsadan oldin)
  console.log('------------------------------------------');
  console.log(`[REGISTRATSIYA] Tel: ${dto.phoneNumber}`);
  console.log(`[KOD]: ${otp}`);
  console.log('------------------------------------------');

  // 3. Kodni Redisda saqlash
  await this.redis.set(`otp:${dto.phoneNumber}`, otp, 'EX', 300);

  // 4. SMS yuborish (try-catch ichida, xato bo'lsa ham terminalda kod qolaveradi)
  try {
    await this.smsService.send(dto.phoneNumber, `Tasdiqlash kodi: ${otp}`);
  } catch (error) {
    this.logger.error(`SMS yuborishda xatolik: ${error}`);
    // SMS ketmasa ham test davom etaveradi
  }

  return { 
    message: "Tasdiqlash kodi yuborildi.",
    hint: "Test rejimidasiz, kodni terminaldan oling" 
  };
}
async forgotPassword(dto: ForgotPasswordDto) {
  const user = await this.userRepository.findOneBy({ phoneNumber: dto.phoneNumber });
  if (!user) throw new NotFoundException("Foydalanuvchi topilmadi");

  const otp = Math.floor(1000 + Math.random() * 9000).toString();
  
  // Reset kodni Redisda saqlash
  await this.redis.set(`reset_otp:${dto.phoneNumber}`, otp, 'EX', 300);

  // Eskiz test SMS yuborish
  await this.smsService.send(dto.phoneNumber, `Bu Eskiz dan test`);

  // Kodni terminalga chiqarish
  console.log('------------------------------------------');
  console.log(`[PAROL TIKLASH] Tel: ${dto.phoneNumber}`);
  console.log(`[KOD]: ${otp}`);
  console.log('------------------------------------------');

  return { message: "Parolni tiklash kodi yuborildi." };
};

async verifyOtp(dto: VerifyOtpDto) {
  const savedCode = await this.redis.get(`otp:${dto.phoneNumber}`);
  
  if (!savedCode || savedCode !== dto.code) {
    throw new BadRequestException("Kod noto'g'ri yoki muddati o'tgan");
  };

  // Kod to'g'ri bo'lsa, "verified" belgisini qo'yamiz
  await this.redis.set(`verified:${dto.phoneNumber}`, 'true', 'EX', 600); // 10 daqiqa vaqt ism/parol uchun
  await this.redis.del(`otp:${dto.phoneNumber}`); // Ishlatilgan kodni o'chiramiz

  return { message: "Kod tasdiqlandi, endi ma'lumotlaringizni kiriting" };
};

  // 2. Register (Kodni tekshirish va parolni saqlash)
  async completeRegister(dto: CompleteRegisterDto) {
  const isVerified = await this.redis.get(`verified:${dto.phoneNumber}`);
  if (!isVerified) {
    throw new BadRequestException("Avval telefon raqamingizni tasdiqlang");
  };

  // Parolni hashlaymiz
  const hashedPassword = await bcrypt.hash(dto.password, 10);
  
  // Userni bazadan qidiramiz yoki yaratamiz
  let user = await this.userRepository.findOneBy({ phoneNumber: dto.phoneNumber });
  
  if (!user) {
    user = this.userRepository.create({ phoneNumber: dto.phoneNumber });
  };

  user.fullName = dto.fullName;
  user.password = hashedPassword;
  user.isVerified = true; // Endi foydalanuvchi tasdiqlangan

  await this.userRepository.save(user);
  await this.redis.del(`verified:${dto.phoneNumber}`); 

  return { message: "Muvaffaqiyatli ro'yxatdan o'tdingiz" };
}

  // 3. Login (Parolni tekshirish)
  async login(dto: LoginDto) {
  const user = await this.userRepository.createQueryBuilder("user")
    .addSelect("user.password")
    .where("user.phoneNumber = :phone", { phone: dto.phoneNumber })
    .getOne();
  if (!user || !user.isVerified) {
    throw new UnauthorizedException("Foydalanuvchi topilmadi yoki tasdiqlanmagan");
  }

  const isMatch = await bcrypt.compare(dto.password, user.password);
  if (!isMatch) {
    throw new UnauthorizedException("Telefon raqami yoki parol noto'g'ri");
  }

  // --- BU YERGA ROLE QO'SHILDI ---
  const payload = { 
    sub: user.id, 
    phoneNumber: user.phoneNumber, 
    role: user.role // AdminGuard shu yerdan o'qiydi
  };

  return {
    access_token: this.jwtService.sign(payload),
  };
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
  const savedCode = await this.redis.get(`reset_otp:${dto.phoneNumber}`);

  if (!savedCode || savedCode !== dto.code) {
    throw new BadRequestException("Kod noto'g'ri yoki muddati o'tgan");
  };

  const user = await this.userRepository.findOneBy({ phoneNumber: dto.phoneNumber });
  if (!user) throw new NotFoundException("Foydalanuvchi topilmadi");

  // Yangi parolni hashlaymiz
  user.password = await bcrypt.hash(dto.newPassword, 10);
  await this.userRepository.save(user);

  // Ishlatilgan kodni o'chiramiz
  await this.redis.del(`reset_otp:${dto.phoneNumber}`);

  return { message: "Parolingiz muvaffaqiyatli yangilandi. Endi login qilishingiz mumkin." };
};
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