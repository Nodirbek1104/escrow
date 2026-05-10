import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export enum TransactionType {
  HOLD = 'hold',
  CHARGE = 'charge',
  DISMISS = 'dismiss',
  PAYOUT = 'payout',
}

export enum TransactionStatus {
  PENDING = 'pending',
  HELD = 'held',
  CHARGED = 'charged',
  DISMISSED = 'dismissed',
  /** Payout is held back awaiting admin approval (high amount / KYC etc.). */
  AWAITING_APPROVAL = 'awaiting_approval',
  /** Admin denied a pending payout — won't be sent to Paylov. */
  DENIED = 'denied',
  PAID_OUT = 'paid_out',
  FAILED = 'failed',
}

/**
 * Audit/reconciliation record of every Paylov-side payment action.
 * One escrow contract may produce several rows: hold, charge, payout, dismiss.
 */
@Entity('payment_transactions')
@Index(['contractId'])
@Index(['paylovTransactionId'])
@Index(['extId'], { unique: true, where: '"extId" IS NOT NULL' })
export class PaymentTransaction {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'enum', enum: TransactionType })
  type!: TransactionType;

  @Column({ type: 'enum', enum: TransactionStatus, default: TransactionStatus.PENDING })
  status!: TransactionStatus;

  @Column({ nullable: true })
  contractId?: number;

  @Column({ nullable: true })
  userId?: number;

  /** Card the funds are pulled from (for holds) or sent to (for payouts). */
  @Column({ nullable: true })
  cardId?: string;

  /** Paylov-side transaction id, returned by hold/create or payout. */
  @Column({ nullable: true })
  paylovTransactionId?: string;

  /** Idempotency key sent to Paylov as `extId`. */
  @Column({ nullable: true })
  extId?: string;

  /** Always stored in tiyin (1 sum = 100 tiyin). */
  @Column({ type: 'bigint', default: 0 })
  amount!: number;

  /** Last raw payload returned by Paylov, useful for debugging. */
  @Column({ type: 'jsonb', nullable: true })
  rawResponse?: any;

  /** Last error returned by Paylov, if any. */
  @Column({ type: 'jsonb', nullable: true })
  lastError?: any;

  /** Admin user id who approved/denied this payout. Null until reviewed. */
  @Column({ type: 'integer', nullable: true })
  approvedBy?: number | null;

  @Column({ type: 'timestamp', nullable: true })
  approvedAt?: Date | null;

  /** Reason if denied (or any audit note from admin on approval). */
  @Column({ type: 'text', nullable: true })
  approvalNote?: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
