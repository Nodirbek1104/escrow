import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { AuditLogService } from './audit-log.service';

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private readonly auditLogService: AuditLogService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
   

    const { method, url, ip, headers } = request;

    return next.handle().pipe(
      tap({
        next: (data) => {
          // MUHIM: request.user ni aynan shu yerda, so'rov bajarilib bo'lingach olish kerak
          const user = request.user; 

          this.auditLogService.createLog({
            userId: user?.userId  || null, // Endi bu yerda ID bo'ladi
            action: `${method} ${url}`,
            status: 'SUCCESS',
            ipAddress: ip,
            headers: JSON.stringify(headers),
          });
        },
        error: (err) => {
          const user = request.user;
          this.auditLogService.createLog({
            userId: user?.userId ||null,
            action: `${method} ${url}`,
            status: `ERROR: ${err.message}`,
            ipAddress: ip,
            headers: JSON.stringify(headers),
          });
        },
      }),
    );
  }
}