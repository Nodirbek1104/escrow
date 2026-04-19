import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EscrocontractsService } from './escrocontracts.service'; 
import { EscrowContractController } from './escrocontracts.controller'; 
import { EscrowContract } from './entities/escrocontract.entity';
import { User } from '../user/entities/user.entity';
import { SmsModule } from '../sms/sms.module';
import { AuditLogModule } from '../audit-log/audit-log.module';

@Module({
  imports: [TypeOrmModule.forFeature([EscrowContract, User]),AuditLogModule, SmsModule],
  controllers: [EscrowContractController], 
  providers: [EscrocontractsService], 
  exports: [EscrocontractsService]
})
export class EscrocontractsModule {}