import { Module } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { PaymentController } from './payment.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Card } from './entities/payment.entity';
import { ConfigModule } from '@nestjs/config'; // 1. Shuni import qiling

@Module({
  imports: [
    TypeOrmModule.forFeature([Card]),
    ConfigModule, // 2. Imports qismiga qo'shing
  ],
  controllers: [PaymentController],
  providers: [PaymentService],
  exports: [PaymentService]
})
export class PaymentModule {}