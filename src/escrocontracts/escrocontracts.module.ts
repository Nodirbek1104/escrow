import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EscrocontractsService } from './escrocontracts.service'; 
import { EscrocontractsController} from './escrocontracts.controller'; 
import { EscrowContract } from './entities/escrocontract.entity';
import { User } from '../user/entities/user.entity';
import { SmsModule } from '../user/sms.module';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { PaymentModule } from '../payment/payment.module';

@Module({
  imports: [TypeOrmModule.forFeature([EscrowContract, User]),AuditLogModule, SmsModule, PaymentModule, SmsModule], 
  controllers: [EscrocontractsController], 
  providers: [EscrocontractsService], 
  exports: [EscrocontractsService]
})
export class EscrocontractsModule {}