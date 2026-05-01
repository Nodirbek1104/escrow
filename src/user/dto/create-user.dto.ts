import { IsPhoneNumber, IsNotEmpty, IsString, Length, MinLength, IsOptional, IsEnum } from 'class-validator';
import { UserRole } from '../entities/user.entity';

// 1. SMS yuborish
export class SendOtpDto {
    @IsNotEmpty({ message: "Telefon raqami bo'sh bo'lmasligi kerak" })
    @IsPhoneNumber('UZ', { message: "Telefon raqami noto'g'ri formatda (+998xxxxxxx)" })
    phoneNumber!: string;
}

// 2. Kodni tekshirish
export class VerifyOtpDto {
    @IsPhoneNumber('UZ')
    phoneNumber!: string;

    @Length(4, 6)
    code!: string;
}

// 3. Ro'yxatdan o'tishni yakunlash
export class CompleteRegisterDto {
    @IsNotEmpty()
    @IsPhoneNumber('UZ')
    phoneNumber!: string;

    @IsString()
    @IsNotEmpty()
    fullName!: string;

    @IsNotEmpty()
    @MinLength(6, { message: "Parol kamida 6 ta belgidan iborat bo'lishi kerak" })
    password!: string;
}

// 4. Login
export class LoginDto {
    @IsNotEmpty()
    @IsString()
    phoneNumber!: string;

    @IsNotEmpty()
    @IsString()
    password!: string;
}

// 5. Parol tiklash uchun SMS yuborish
export class ForgotPasswordDto {
  @IsPhoneNumber('UZ')
  phoneNumber!: string;
}

// 6. Yangi parol o'rnatish
export class ResetPasswordDto {
  @IsPhoneNumber('UZ')
  phoneNumber!: string;

  @Length(4, 6)
  code!: string;

  @MinLength(6, { message: "Yangi parol kamida 6 belgidan iborat bo'lishi kerak" })
  newPassword!: string;
}

// 7. Admin uchun: Foydalanuvchini tahrirlash (UPDATE DTO)
export class UpdateUserDto {
  @IsOptional()
  @IsString()
  fullName?: string;

  @IsOptional()
  @IsString()
  @MinLength(6)
  password?: string;

  @IsOptional()
  @IsEnum(UserRole, { message: "Noto'g'ri rol kiritildi" })
  role?: UserRole;
  
  @IsOptional()
  @IsString()
  phoneNumber?: string;
}