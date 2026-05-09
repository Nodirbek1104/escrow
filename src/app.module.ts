import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserModule } from './user/user.module';
import dotenv from "dotenv";
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
import { NotificationsModule } from './notifications/notifications.module';
import { SettingsModule } from './settings/settings.module';

dotenv.config();

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true, 
    }),
    ServeStaticModule.forRoot({
      rootPath: process.env.NODE_ENV === 'production' 
        ? '/home/ubuntu/escro-frontend/dist/client' 
        : join(__dirname, '..', 'uploads'),
      exclude: ['/api*'],
    }),
    // Named throttler buckets. Routes can opt into a stricter one via
    // @Throttle({ <name>: { limit, ttl } }). The 'default' bucket applies
    // when a route doesn't specify anything.
    ThrottlerModule.forRoot([
      { name: 'default', ttl: 60_000, limit: 60 },
      { name: 'auth', ttl: 60_000, limit: 10 },
      { name: 'otp', ttl: 60_000, limit: 3 },
    ]),
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
    NotificationsModule,
    SettingsModule,
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
  ],
})
export class AppModule {}
