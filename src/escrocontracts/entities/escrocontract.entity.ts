
import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, ManyToOne,
} from 'typeorm';
import { User } from '../../user/entities/user.entity';

export enum EscrowStatus {
  DRAFT     = 'draft',
  PENDING   = 'pending',
  REVISION  = 'revision',
  REJECTED  = 'rejected',
  ACCEPTED  = 'accepted',
  ACTIVE    = 'active',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
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

  @ManyToOne(() => User, { eager: false, cascade: false })
  creator!: User;
}