import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, ManyToOne, JoinColumn
} from 'typeorm';
import { User } from '../../user/entities/user.entity';

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

  // --- To'lov bilan bog'liq yangi maydonlar ---

  @Column({ nullable: true })
  transactionId?: string; // Paylov'dan qaytgan muzlatilgan pul IDsi

  @Column({ nullable: true })
  senderCardId?: string; // Pul yechib olingan xaridorning karta IDsi

  @Column({ nullable: true })
  receiverCardId?: string; // Pul tushishi kerak bo'lgan ijrochining karta IDsi

  @Column({ nullable: true })
  executorId?: number;
  // --------------------------------------------

  @Column({ nullable: true })
  deadline!: number;

  @Column({ type: 'varchar', nullable: true })
  technicalTermsFile?: string | null;

  @Column({ type: 'text', nullable: true })
  generatedContractText?: string | null;

  @Column({ type: 'enum', enum: EscrowStatus, default: EscrowStatus.PENDING })
  status!: EscrowStatus;

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