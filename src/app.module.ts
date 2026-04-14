import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config'; // <--- Mana shu qator kerak
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserModule } from './user/user.module';
import dotenv, { config } from "dotenv";
import { RedisModule } from '@nestjs-modules/ioredis';
import { EscrocontractsModule } from './escrocontracts/escrocontracts.module';

dotenv.config();

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true, // Hamma joyda ishlatish uchun
    }),
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
      synchronize:true,
    }),
    UserModule,
    EscrocontractsModule,
  

  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
