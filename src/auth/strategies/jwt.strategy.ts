import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable } from '@nestjs/common';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET || 'safil_maxfiy_kalit_2026',
    });
  }

  async validate(payload: any) {
    // Bu yerda qaytgan ob'ekt request.user ichiga joylashadi
    return { userId: payload.sub, phoneNumber: payload.phoneNumber, role: payload.role };
  }
}