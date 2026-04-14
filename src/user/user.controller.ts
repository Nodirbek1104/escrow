import { Controller, Post, Body, HttpCode, HttpStatus, UseGuards, Get, Request, Patch } from '@nestjs/common';
import { UserService } from './user.service';
import { SendOtpDto, CompleteRegisterDto, LoginDto, VerifyOtpDto, ForgotPasswordDto, ResetPasswordDto } from './dto/create-user.dto';
import {UpdateUserDto} from './dto/update-user.dto'
import { AuthGuard } from '@nestjs/passport'; // Mana shu qatorni qo'shing

@Controller('auth') // 'user' emas 'auth' qilish mantiqan to'g'riroq
export class UserController {
  constructor(private readonly userService: UserService) {}

  // 1. SMS yuborish
  @Post('send-otp')
  @HttpCode(HttpStatus.OK)
  async sendOtp(@Body() sendOtpDto: SendOtpDto) {
    return this.userService.sendOtp(sendOtpDto);
  }
  @Post('verify-otp')
@HttpCode(HttpStatus.OK)
async verifyOtp(@Body() verifyOtpDto: VerifyOtpDto) {
  return this.userService.verifyOtp(verifyOtpDto);
}

  // 2. Ro'yxatdan o'tishni yakunlash (SMS kod + Parol)
  @Post('register')
  async register(@Body() completeDto: CompleteRegisterDto) {
    return this.userService.completeRegister(completeDto);
  }

  // 3. Login (Telefon + Parol)
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() loginDto: LoginDto) {
    return this.userService.login(loginDto);
  }

  @UseGuards(AuthGuard('jwt'))
 @Get('profile')
async getProfile(@Request() req) {
  return await this.userService.getProfile(req.user.userId);
}

  @UseGuards(AuthGuard('jwt'))
@Post('logout')
async logout(@Request() req) {
  const token = req.headers.authorization.split(' ')[1];
  // 86400 sekund = 1 kun (tokeningiz muddatiga qarab belgilang)
  return this.userService.logout(token, 86400); 
}
@UseGuards(AuthGuard('jwt'))
@Patch('update-profile') // Patch - qisman yangilash uchun ishlatiladi
async updateProfile(@Request() req, @Body() dto: UpdateUserDto) {
  // req.user ichida JwtStrategy'dan qaytgan userId bo'ladi
  return this.userService.updateProfile(req.user.userId, dto);
}
@Post('forgot-password')
@HttpCode(HttpStatus.OK)
async forgotPassword(@Body() dto: ForgotPasswordDto) {
  return this.userService.forgotPassword(dto);
}

@Post('reset-password')
@HttpCode(HttpStatus.OK)
async resetPassword(@Body() dto: ResetPasswordDto) {
  return this.userService.resetPassword(dto);
}
}