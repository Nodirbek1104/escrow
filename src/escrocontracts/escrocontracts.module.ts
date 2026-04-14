import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EscrowContractService } from './escrocontracts.service'; // Nomini to'g'rilang
import { EscrowContractController } from './escrocontracts.controller'; // Nomini to'g'rilang
import { EscrowContract } from './entities/escrocontract.entity';
import { User } from '../user/entities/user.entity';
import { SmsModule } from '../sms/sms.module';

@Module({
  imports: [TypeOrmModule.forFeature([EscrowContract, User]), SmsModule],
  controllers: [EscrowContractController], // Bu yerda ham
  providers: [EscrowContractService], // Va bu yerda ham
  exports: [EscrowContractService]
})
export class EscrocontractsModule {}