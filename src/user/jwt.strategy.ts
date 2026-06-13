import { ExtractJwt, Strategy, StrategyOptionsWithRequest } from 'passport-jwt'; // StrategyOptionsWithRequest qo'shildi
import { PassportStrategy } from '@nestjs/passport';
import { Injectable } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(@InjectRedis() private readonly redis: Redis) {
    // 1. Sozlamalarni alohida o'zgaruvchiga olamiz va turini ko'rsatamiz
    const options: StrategyOptionsWithRequest = {
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET || 'Sizning_Maxfiy_Kalitingiz',
      passReqToCallback: true, // Endi bu yerda xato bermaydi
    };

    // 2. Super-ga o'sha o'zgaruvchini beramiz
    super(options);
  }

async validate(req: any, payload: any) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    console.error('[JWT] Authorization header yo\'q!');
    return null;
  }

  const token = authHeader.split(' ')[1];
  if (!token) {
    console.error('[JWT] Token bo\'sh!');
    return null;
  }

  try {
    const isBlacklisted = await this.redis.get(token);
    if (isBlacklisted) {
      console.error('[JWT] Token blacklistda!');
      return null;
    }
  } catch (redisError) {
    // ⚠️ Redis xato bo'lsa — tokeni bloklama, o'tkazib yubor!
    console.error('[JWT] Redis xatosi, o\'tkazib yuborildi:', redisError);
  }

  return {
    userId: payload.sub,
    phone: payload.phoneNumber,
    role: payload.role
  };
}
}