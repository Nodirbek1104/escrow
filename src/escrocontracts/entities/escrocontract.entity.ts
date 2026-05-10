import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, ManyToOne, JoinColumn
} from 'typeorm';
import { User } from '../../user/entities/user.entity';

export enum CreatorRole {
  BUYER = 'buyer',
  EXECUTOR = 'executor',
}

export enum EscrowStatus {
  DRAFT     = 'draft',
  PENDING   = 'pending', // Yaratildi, ijrochi tasdiqlashini kutmoqda
  REVISION  = 'revision',
  REJECTED  = 'rejected',
  ACCEPTED  = 'accepted', // Ijrochi tasdiqladi, xaridor pulni to'lashi (muzlatishi) kerak
  PAYMENT_HELD = 'payment_held', // Pul Paylovda muzlatildi (Escrow xavfsiz holatda)
  ACTIVE    = 'active',   // Ish jarayoni ketmoqda
  COMPLETED = 'completed', // Ish yakunlandi, pul ijrochiga o'tkazildi
  CANCELLED = 'cancelled', // Bekor qilindi, pul xaridorga qaytarildi
  DISPUTED  = 'disputed',  // Nizo holatida (Admin aralashuvi kerak)
}

@Entity('escrow_contracts')
export class EscrowContract {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  title!: string;

  @Column('decimal', {
    precision: 12,
    scale: 2,
    transformer: {
      to: (value: number) => value,
      from: (value: string) => parseFloat(value),
    },
  })
  amount!: number;

  /**
   * Platform fee, frozen at create time so future percentage changes do not
   * retroactively rewrite older contracts. Buyer is charged
   * `amount + commissionAmount`; executor receives `amount`.
   */
  @Column('decimal', {
    precision: 12,
    scale: 2,
    default: 0,
    transformer: {
      to: (value: number) => value ?? 0,
      from: (value: string) => parseFloat(value ?? '0'),
    },
  })
  commissionAmount!: number;

  // --- To'lov bilan bog'liq yangi maydonlar ---

  @Column({ nullable: true })
  transactionId?: string; // Paylov'dan qaytgan muzlatilgan pul IDsi

  @Column({ nullable: true })
  senderCardId?: string; // Pul yechib olingan xaridorning karta IDsi

  @Column({ nullable: true })
  receiverCardId?: string; // Pul tushishi kerak bo'lgan ijrochining karta IDsi

  @Column({ nullable: true })
  executorId?: number;

  /** Pinned message id for the contract chat (Telegram-style sticky). */
  @Column({ type: 'integer', nullable: true })
  pinnedMessageId?: number | null;

  /**
   * Timestamp of the last "deadline overdue" SLA notification we sent for
   * this contract. Used to make the SLA cron one-shot per contract so
   * participants aren't pinged every hour. Null = never warned.
   */
  @Column({ type: 'timestamp', nullable: true })
  slaWarnedAt?: Date | null;
  // --------------------------------------------

  @Column({ nullable: true })
  deadline!: number;

  @Column({ type: 'varchar', nullable: true })
  technicalTermsFile?: string | null;

  @Column({ type: 'text', nullable: true })
  generatedContractText?: string | null;

  @Column({ type: 'enum', enum: EscrowStatus, default: EscrowStatus.PENDING })
  status!: EscrowStatus;

  /**
   * Who created the contract: 'buyer' (default — buyer makes the offer and
   * invites an executor) or 'executor' (executor publishes an "Offer" and
   * invites a buyer to fund it). Affects which side has to pay vs. accept,
   * but the rest of the flow (charge / payout / cancel) is identical.
   */
  @Column({
    type: 'enum',
    enum: CreatorRole,
    default: CreatorRole.BUYER,
  })
  creatorRole!: CreatorRole;

  @Column()
  executorPhoneNumber!: string;

  @Column({ type: 'text', nullable: true })
  rejectionReason?: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @ManyToOne(() => User, (user) => user.id)
  @JoinColumn({ name: 'creatorId' })
  creator!: User;

  @Column()
  creatorId!: number; // Creatorning IDsi (oson kirish uchun)
}