import { IsEnum, IsOptional } from 'class-validator';
import { CompleteRegisterDto } from './create-user.dto'; // Yo'lni tekshiring
import { UserRole } from '../entities/user.entity';

// Super Admin yangi admin qo'shayotganda ishlatadi
export class AdminCreateDto extends CompleteRegisterDto {
  @IsOptional() // Agar yuborilmasa, Service baribir ADMIN qiladi
  @IsEnum(UserRole)
  role?: UserRole;
}