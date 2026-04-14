import { Controller, Get, Patch, Body, Param, UseGuards, Delete, ForbiddenException, ParseIntPipe, Request, Post } from '@nestjs/common';
import { UserService } from './user.service';
import { AdminGuard } from '../auth/guards/admin.guard'; 
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard'; // To'g'ri joydan import
import { UpdateUserDto } from './dto/update-user.dto';
import { UserRole } from './entities/user.entity';
import { AdminCreateDto } from './dto/create-admin.dto';

@Controller('admin')
@UseGuards(JwtAuthGuard, AdminGuard) // Ketma-ketlik: 1. Login, 2. Adminlik
export class AdminController {
  constructor(private readonly userService: UserService) {}

  // 1. Barcha foydalanuvchilarni ko'rish
  @Get('users')
  async findAll() {
    return this.userService.findAll();
  }

  // src/user/admin.controller.ts

@Post('create-admin')
@UseGuards(JwtAuthGuard, AdminGuard)
async createAdmin(@Body() dto: AdminCreateDto) { // To'g'ri DTO ni ulaymiz
  return this.userService.createAdmin(dto);
}

  // 2. Foydalanuvchi ma'lumotlarini va rolini tahrirlash
  @Patch('users/:id')
  async update(
    @Param('id', ParseIntPipe) id: number, 
    @Body() dto: UpdateUserDto,
    @Request() req: any
  ) {
    // Xavfsizlik: Faqat Super Admin rolni o'zgartira olishi mumkin
    if (dto.role && req.user.role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException("Faqat Super Admin rollarni o'zgartira oladi!");
    }
    return this.userService.update(id, dto);
  }

  // 3. Foydalanuvchini o'chirish
  @Delete('users/:id')
  async remove(@Param('id', ParseIntPipe) id: number, @Request() req: any) {
    // Super admin himoyasi UserService ichida bo'lishi shart (yuqorida gaplashganimizdek)
    return this.userService.remove(id, req.user);
  }
}