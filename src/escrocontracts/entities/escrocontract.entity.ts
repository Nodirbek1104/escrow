import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, ManyToOne, JoinColumn
} from 'typeorm';
import { User } from '../../user/entities/user.entity';

/**
 * Shartnoma turi — bazada faqat ikki tomon (xaridor va ijrochi) bo'ladi,
 * lekin contract_type qaysi tomondan boshlanganligini ko'rsatadi. Buni
 * tushuncha sifatida olish: "buyer_initiated" = xaridor o'z taklifini
 * yaratdi va ijrochini taklif qildi; "executor_initiated" = ijrochi
 * "Offer" ko'rinishida xizmat e'lon qildi va xaridor (mijoz) qabul qiladi.
 */
export enum ContractType {
  BUYER_INITIATED = 'buyer_initiated',
  EXECUTOR_INITIATED = 'executor_initiated',
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
   * Admin user assigned to handle this contract's dispute. Set when the
   * contract first enters DISPUTED (round-robin by current dispute load).
   * Stays set after resolution so we can audit who handled what.
   */
  @Column({ type: 'integer', nullable: true })
  assignedAdminId?: number | null;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'assignedAdminId' })
  assignedAdmin?: User | null;

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
   * Shartnoma qaysi tomondan boshlanganini ko'rsatadi. Ishtirokchilar
   * ro'yxati har doim ikki tomon: xaridor (buyer) va ijrochi (executor) —
   * contract_type esa shu jufdan qaysi biri boshlovchi rolida ekanini
   * aytadi. Bu pul oqimini emas, faqat UI/UX dispatchini boshqaradi
   * (charge / payout / cancel logikasi har ikkala holatda bir xil).
   */
  @Column({
    type: 'varchar',
    length: 32,
    default: ContractType.BUYER_INITIATED,
  })
  contractType!: ContractType;

  @Column()
  executorPhoneNumber!: string;

  @Column({ type: 'text', nullable: true })
  rejectionReason?: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @ManyToOne(() => User, (user) => user.id)
  @JoinColumn({ name: 'creatorId' })
  creator!: User;
  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'executorId' })
  executor?: User;

  @Column()
  creatorId!: number; // Creatorning IDsi (oson kirish uchun)
}