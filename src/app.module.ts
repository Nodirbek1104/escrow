import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config'; // <--- Mana shu qator kerak
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserModule } from './user/user.module';
import dotenv, { config } from "dotenv";
import { RedisModule } from '@nestjs-modules/ioredis';
import { EscrocontractsModule } from './escrocontracts/escrocontracts.module';
import { AuditLogModule } from './audit-log/audit-log.module';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuditInterceptor } from './audit-log/audit-log.interceptor';
import { PaymentModule } from './payment/payment.module';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { TelegramGuard } from './auth/guards/telegram.guard';
import { MessagesModule } from './messages/messages.module';

dotenv.config();

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true, 
    }),
    ThrottlerModule.forRoot([{
      ttl: 60000, // 1 minut
      limit: 15,  // 1 minutda max 15 so'rov
    }]),
    RedisModule.forRoot({
      type: 'single',
      url: 'redis://localhost:6379'
    }),
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      autoLoadEntities: true,
      synchronize: true,
    }),
    UserModule,
    EscrocontractsModule,
    AuditLogModule,
    PaymentModule,
    MessagesModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_INTERCEPTOR,
      useClass: AuditInterceptor,
    },
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    {
      provide: APP_GUARD,
      useClass: TelegramGuard,
    },
  ],
})
export class AppModule {}
