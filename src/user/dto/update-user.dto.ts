import { IsEnum, IsOptional, IsPhoneNumber, IsString, MinLength } from "class-validator";
import { UserRole } from "../entities/user.entity";

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  fullName?: string;

  @IsOptional()
  @IsPhoneNumber('UZ')
  phoneNumber?: string;

  @IsOptional()
  @MinLength(6)
  password?: string;

  @IsOptional()
  @IsString()
  avatarUrl?: string;

  // Mana shu maydon AdminController-dagi xatoni yo'qotadi
  @IsOptional()
  @IsEnum(UserRole, { message: "Noto'g'ri rol kiritildi" })
  role?: UserRole;
}