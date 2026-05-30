import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { AuditInterceptor } from './audit-log/audit-log.interceptor'; // Yo'lni tekshiring
import { AuditLogService } from './audit-log/audit-log.service';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import * as dotenv from 'dotenv';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';

dotenv.config();

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });

  // 1. ValidationPipe
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true
  }));

  // 2. Global exception filter — sanitises every error so neither DB
  //    internals nor stack traces ever reach a client. See
  //    common/filters/global-exception.filter.ts.
  app.useGlobalFilters(new GlobalExceptionFilter());

  app.setGlobalPrefix('api');
  app.enableCors({
    origin: [
      'https://escro.uz',
      'https://aws-dev.escro.uz',
      'http://localhost:5173',
      'http://localhost:3000',
    ],
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
  });

  const config = new DocumentBuilder()
    .setTitle('Escro API')
    .setDescription('The Escro Application API description')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  await app.listen(process.env.PORT ?? 3001, () => {
    console.log(`🚀 Server is running on port ${process.env.PORT ?? 3001}`);
  });
}
bootstrap();



