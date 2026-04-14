import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { JwtStrategy } from './strategies/jwt.strategy';

@Module({
  imports: [
    PassportModule,
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'safil_maxfiy_kalit_2026', // .env faylda bo'lishi kerak
      signOptions: { expiresIn: '7d' }, // Token 7 kun amal qiladi
    }),
  ],
  providers: [JwtStrategy],
  exports: [JwtModule], // Buni export qilish shart, chunki Guard'lar foydalanadi
})
export class AuthModule {}