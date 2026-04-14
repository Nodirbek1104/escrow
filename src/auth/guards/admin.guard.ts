import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { UserRole } from '../../user/entities/user.entity';

@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user = request.user; // JwtAuthGuard'dan kelgan ma'lumot
    if (user && (user.role === UserRole.ADMIN || user.role === UserRole.SUPER_ADMIN)) {
      return true;
    }
    
    throw new ForbiddenException("Kechirasiz, bu bo'limga faqat adminlar kira oladi!");
  }
}