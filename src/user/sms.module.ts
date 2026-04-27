// sms.module.ts
import { Module } from '@nestjs/common';
import { SmsService } from './send.sms.service';
import { RedisModule } from '@nestjs-modules/ioredis';

@Module({
    imports: [RedisModule],
  providers: [SmsService],
  exports: [SmsService], // ← boshqa modullarda ishlatish uchun
})
export class SmsModule {}