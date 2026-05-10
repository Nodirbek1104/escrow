import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, LessThan, Repository } from 'typeorm';
import { EscrowContract, EscrowStatus } from './entities/escrocontract.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { SettingsService } from '../settings/settings.service';
import { User, UserRole } from '../user/entities/user.entity';

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;
const STARTUP_DELAY_MS = 30_000; // wait 30s after boot

/**
 * Periodic background job that keeps contracts moving even when one party
 * goes silent. Two responsibilities:
 *
 *   1. **Stale-pending cancel** — if a buyer never funds an accepted offer
 *      within `sla_pending_grace_days` (default 14), cancel it so the
 *      executor isn't blocked forever.
 *   2. **Overdue warn** — if a payment_held / active contract passes its
 *      delivery deadline by `sla_overdue_warn_days` (default 3), notify
 *      both parties + admins one time. We mark `slaWarnedAt` so we don't
 *      spam the same contract every hour.
 *
 * Implemented with `setInterval` to avoid pulling in `@nestjs/schedule` for
 * a single job. Disable in tests by overriding `start()` if needed.
 */
@Injectable()
export class SlaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SlaService.name);
  private timer: NodeJS.Timeout | null = null;
  private startupTimer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @InjectRepository(EscrowContract)
    private readonly contractRepo: Repository<EscrowContract>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
  ) {}

  onModuleInit() {
    if (process.env.SLA_DISABLED === '1') {
      this.logger.log('SLA cron disabled via SLA_DISABLED=1');
      return;
    }
    this.startupTimer = setTimeout(() => {
      this.tick().catch((e) =>
        this.logger.error(`SLA tick failed at startup: ${(e as Error).message}`),
      );
      this.timer = setInterval(() => {
        this.tick().catch((e) =>
          this.logger.error(`SLA tick failed: ${(e as Error).message}`),
        );
      }, ONE_HOUR_MS);
      this.logger.log('SLA cron armed (every 1h)');
    }, STARTUP_DELAY_MS);
  }

  onModuleDestroy() {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.timer) clearInterval(this.timer);
  }

  /** Public for manual admin trigger (future endpoint) and tests. */
  async tick() {
    if (this.running) {
      this.logger.warn('SLA tick already running, skipping');
      return;
    }
    this.running = true;
    try {
      const cancelled = await this.cancelStalePending();
      const warned = await this.warnOverdue();
      this.logger.log(
        `SLA tick: cancelled=${cancelled}, warnedOverdue=${warned}`,
      );
    } finally {
      this.running = false;
    }
  }

  private async cancelStalePending(): Promise<number> {
    const graceDays = this.settings.getNumber('sla_pending_grace_days', 14);
    const cutoff = new Date(Date.now() - graceDays * ONE_DAY_MS);
    const stuck = await this.contractRepo.find({
      where: {
        status: In([EscrowStatus.PENDING, EscrowStatus.ACCEPTED]),
        createdAt: LessThan(cutoff),
      },
    });
    if (stuck.length === 0) return 0;
    for (const c of stuck) {
      try {
        c.status = EscrowStatus.CANCELLED;
        c.rejectionReason =
          c.rejectionReason ||
          `SLA: ${graceDays} kun ichida to'lov amalga oshirilmadi, avto-bekor qilindi`;
        await this.contractRepo.save(c);
        await this.notifyParticipants(
          c,
          'Shartnoma avto-bekor qilindi',
          `"${c.title}" shartnomasi ${graceDays} kun ichida to'lov bo'lmagani sababli bekor qilindi.`,
          'contract_auto_cancelled',
        );
      } catch (e) {
        this.logger.warn(
          `Failed to cancel stale contract ${c.id}: ${(e as Error).message}`,
        );
      }
    }
    return stuck.length;
  }

  private async warnOverdue(): Promise<number> {
    const warnGraceDays = this.settings.getNumber('sla_overdue_warn_days', 3);
    const candidates = await this.contractRepo.find({
      where: {
        status: In([EscrowStatus.PAYMENT_HELD, EscrowStatus.ACTIVE]),
        slaWarnedAt: IsNull(),
      },
    });
    if (candidates.length === 0) return 0;
    let warned = 0;
    const now = Date.now();
    for (const c of candidates) {
      const deadlineDays = Number(c.deadline) || 0;
      if (deadlineDays <= 0) continue;
      const deadlineMs =
        new Date(c.createdAt).getTime() +
        (deadlineDays + warnGraceDays) * ONE_DAY_MS;
      if (now < deadlineMs) continue;

      try {
        c.slaWarnedAt = new Date();
        await this.contractRepo.save(c);
        await this.notifyParticipants(
          c,
          'Shartnoma muddati o‘tib ketdi',
          `"${c.title}" shartnomasi belgilangan muddatdan ${warnGraceDays}+ kun o‘tdi. Iltimos, holatni hal qiling yoki nizo oching.`,
          'contract_overdue',
        );
        await this.notifyAdmins(
          'SLA: shartnoma muddati o‘tdi',
          `#${c.id} "${c.title}" — ishtirokchilarga ogohlantirish yuborildi.`,
          'contract_overdue_admin',
          String(c.id),
        );
        warned++;
      } catch (e) {
        this.logger.warn(
          `Failed to warn overdue contract ${c.id}: ${(e as Error).message}`,
        );
      }
    }
    return warned;
  }

  private async notifyParticipants(
    c: EscrowContract,
    title: string,
    message: string,
    type: string,
  ): Promise<void> {
    const userIds = new Set<number>();
    if (c.creatorId) userIds.add(c.creatorId);
    if (c.executorId) userIds.add(c.executorId);
    for (const uid of userIds) {
      await this.notifications
        .create(uid, title, message, type, String(c.id))
        .catch(() => undefined);
    }
  }

  private async notifyAdmins(
    title: string,
    message: string,
    type: string,
    relatedId?: string,
  ): Promise<void> {
    const admins = await this.userRepo.find({
      where: [{ role: UserRole.ADMIN }, { role: UserRole.SUPER_ADMIN }],
      select: ['id'],
    });
    for (const a of admins) {
      await this.notifications
        .create(a.id, title, message, type, relatedId)
        .catch(() => undefined);
    }
  }
}
