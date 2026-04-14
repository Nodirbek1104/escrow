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
dotenv.config();

@Module({
  imports: [
    TypeOrmModule.forFeature([User]),
    JwtModule.register({
      secret: process.env.JWT_SECRET,
      signOptions: { expiresIn: '1d' },
    }),
    AuthModule,
  ],
  controllers: [UserController, AdminController],
  providers: [UserService, SuperAdminSeed], // ← JwtStrategy olib tashlandi
  exports: [UserService],
})
export class UserModule {}