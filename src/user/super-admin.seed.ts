import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User, UserRole } from './entities/user.entity';
import * as bcrypt from 'bcrypt';
import dotenv from 'dotenv'


dotenv.config()

@Injectable()
export class SuperAdminSeed implements OnApplicationBootstrap {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  async onApplicationBootstrap() {
    await this.seed();
  }

  async seed() {
    // 1. Super admin bor-yo'qligini tekshirish
    const superAdmin = await this.userRepository.findOne({
      where: { role: UserRole.SUPER_ADMIN },
    });

    if (superAdmin) {
      // Mavjud bo'lsa parolni yangilab qo'yamiz (har ehtimolga qarshi)
      const hashedPassword = await bcrypt.hash(process.env.SUPER_ADMIN_PASSWORD || 'Siroj0948@', 10);
      superAdmin.password = hashedPassword;
      superAdmin.phoneNumber = process.env.SUPER_ADMIN_PHONE || '+998999560948';
      await this.userRepository.save(superAdmin);
      return;
    }

    // 2. Agar yo'q bo'lsa, yangi yaratamiz
    const hashedPassword = await bcrypt.hash(process.env.SUPER_ADMIN_PASSWORD || 'Siroj0948@', 10);
    
    const newSuperAdmin = this.userRepository.create({
      phoneNumber: process.env.SUPER_ADMIN_PHONE || '+998999560948',
      fullName: 'Safil Super Admin',
      password: hashedPassword,
      role: UserRole.SUPER_ADMIN,
      isVerified: true,
    });

    await this.userRepository.save(newSuperAdmin);
    console.log('✅ Super Admin muvaffaqiyatli yaratildi!');
  }
}