import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EscrocontractsService } from './escrocontracts.service';
import { EscrocontractsController} from './escrocontracts.controller';
import { EscrowContract } from './entities/escrocontract.entity';
import { DisputeEvidence } from './dispute-evidence.entity';
import { DisputeEvidenceService } from './dispute-evidence.service';
import { DisputeEvidenceController } from './dispute-evidence.controller';
import { SlaService } from './sla.service';
import { User } from '../user/entities/user.entity';
import { SmsModule } from '../user/sms.module';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { PaymentModule } from '../payment/payment.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { MessagesModule } from '../messages/messages.module';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([EscrowContract, User, DisputeEvidence]),
    AuditLogModule,
    SmsModule,
    PaymentModule,
    NotificationsModule,
    MessagesModule,
    SettingsModule,
  ],
  controllers: [EscrocontractsController, DisputeEvidenceController],
  providers: [EscrocontractsService, DisputeEvidenceService, SlaService],
  exports: [EscrocontractsService, DisputeEvidenceService],
})
export class EscrocontractsModule {}