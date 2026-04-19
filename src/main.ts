import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { AuditInterceptor } from './audit-log/audit-log.interceptor'; // Yo'lni tekshiring
import { AuditLogService } from './audit-log/audit-log.service';
import * as dotenv from 'dotenv';

dotenv.config();

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // 1. ValidationPipe
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true
  }));


  await app.listen(process.env.PORT ?? 3000, () => {
    console.log(`🚀 Server is running on port ${process.env.PORT ?? 3000}`);
  });
}
bootstrap();



