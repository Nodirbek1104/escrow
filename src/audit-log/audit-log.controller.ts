import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuditLogService } from './audit-log.service';
import { AdminGuard } from '../auth/guards/admin.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Controller('admin/audit-logs')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AuditLogController {
  constructor(private readonly auditLogService: AuditLogService) {}

  @Get()
  async findAll() {
    return this.auditLogService.findAll();
  }
}
