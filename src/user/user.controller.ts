import { Controller, Post, Body, HttpCode, HttpStatus, UseGuards, Get, Request, Patch, Headers } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
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
  @Throttle({ otp: { limit: 3, ttl: 60_000 } })
  async sendOtp(@Body() sendOtpDto: SendOtpDto) {
    return this.userService.sendOtp(sendOtpDto);
  }

  @Post('verify-otp')
  @HttpCode(HttpStatus.OK)
  @Throttle({ auth: { limit: 10, ttl: 60_000 } })
  async verifyOtp(@Body() verifyOtpDto: VerifyOtpDto) {
    return this.userService.verifyOtp(verifyOtpDto);
  }

  // 2. Ro'yxatdan o'tishni yakunlash (SMS kod + Parol)
  @Post('register')
  @Throttle({ auth: { limit: 5, ttl: 60_000 } })
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

  // 3. Login (Telefon + Parol)
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ auth: { limit: 10, ttl: 60_000 } })
  async login(
    @Body() loginDto: LoginDto,
    @Headers('x-tg-data') tgData?: string,
  ) {
    const result = await this.userService.login(loginDto);
    if (result?.user?.id && tgData) {
      void this.userService.linkTelegramFromInitData(result.user.id, tgData);
    }
    return result;
  }

  // 3b. Telegram Mini-App auto-login.
  // Returning users skip phone+OTP entirely once their telegramId is linked.
  @Post('telegram')
  @HttpCode(HttpStatus.OK)
  @Throttle({ auth: { limit: 20, ttl: 60_000 } })
  async loginTelegram(@Body() body: { initData: string }) {
    return this.userService.loginByTelegram(body?.initData);
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
@Throttle({ otp: { limit: 3, ttl: 60_000 } })
async forgotPassword(@Body() dto: ForgotPasswordDto) {
  return this.userService.forgotPassword(dto);
}

@Post('reset-password')
@HttpCode(HttpStatus.OK)
@Throttle({ auth: { limit: 5, ttl: 60_000 } })
async resetPassword(@Body() dto: ResetPasswordDto) {
  return this.userService.resetPassword(dto);
}
}