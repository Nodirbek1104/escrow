import { Controller, Get, Patch, Body, Param, UseGuards, Delete, ForbiddenException, ParseIntPipe, Request, Post } from '@nestjs/common';
import { UserService } from './user.service';
import { AdminGuard } from '../auth/guards/admin.guard'; 
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard'; 
import { UpdateUserDto } from './dto/update-user.dto';
import { UserRole } from './entities/user.entity';
import { AdminCreateDto } from './dto/create-admin.dto';
import { AuditInterceptor } from '../audit-log/audit-log.interceptor';
import { UseInterceptors } from '@nestjs/common';

@Controller('admin')
@UseInterceptors(AuditInterceptor)
export class AdminController {
  constructor(private readonly userService: UserService) {}

  @Get('users')
  @UseGuards(JwtAuthGuard, AdminGuard)
  async findAll() {
    return this.userService.findAll();
  }

  @Get('check-root')
  async checkRoot() {
    return this.userService.findByRole(UserRole.SUPER_ADMIN);
  }

  @Post('create-admin')
  @UseGuards(JwtAuthGuard, AdminGuard)
  async createAdmin(@Body() dto: AdminCreateDto) { 
    return this.userService.createAdmin(dto);
  }

  @Patch('users/:id')
  @UseGuards(JwtAuthGuard, AdminGuard)
  async update(
    @Param('id', ParseIntPipe) id: number, 
    @Body() dto: UpdateUserDto,
    @Request() req: any
  ) {
    if (dto.role && req.user.role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException("Faqat Super Admin rollarni o'zgartira oladi!");
    }
    return this.userService.update(id, dto);
  }

  @Delete('users/:id')
  @UseGuards(JwtAuthGuard, AdminGuard)
  async remove(@Param('id', ParseIntPipe) id: number, @Request() req: any) {
    return this.userService.remove(id, req.user);
  }
}