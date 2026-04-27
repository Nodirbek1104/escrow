import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { UserService } from './user.service';
import { UserController } from './user.controller';
import { User } from './entities/user.entity';
import { SuperAdminSeed } from './super-admin.seed';
import { AdminController } from './admin.controller';
import { AuthModule } from '../auth/auth.module';
import dotenv from 'dotenv';
import { UserDevice } from './entities/user-device.entity';
import { JwtStrategy } from './jwt.strategy';
import { SmsModule } from './sms.module';
dotenv.config();

@Module({
  imports: [
    TypeOrmModule.forFeature([User, UserDevice]),
    JwtModule.register({
      secret: process.env.JWT_SECRET,
      signOptions: { expiresIn: '1d' },
    }),
    AuthModule,
    SmsModule
  ],
  controllers: [UserController, AdminController],
  providers: [UserService, SuperAdminSeed, JwtStrategy], // ← JwtStrategy olib tashlandi
  exports: [UserService, TypeOrmModule],
})
export class UserModule {}