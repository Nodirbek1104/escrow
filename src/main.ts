import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import dotenv from 'dotenv'


dotenv.config()

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true
  }))
  await app.listen(process.env.PORT ?? 3000, 
    ()=>console.log(`server is running on port ${process.env.PORT}`));
}
bootstrap();





