import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditLog } from './entities/audit-log.entity';

@Injectable()
export class AuditLogService {
  constructor(
    @InjectRepository(AuditLog)
    private readonly auditLogRepo: Repository<AuditLog>,
  ) {}

  async createLog(data: any) {
    try {
      const newLog = this.auditLogRepo.create(data);
      
      // Double casting: avval unknown-ga, keyin AuditLog-ga
      const savedLog = (await this.auditLogRepo.save(newLog)) as unknown as AuditLog;
      
      return savedLog;
    } catch (error) {
    }
  }

  async findAll() {
    return this.auditLogRepo.find({
      order: { createdAt: 'DESC' },
      take: 100,
    });
  }
}