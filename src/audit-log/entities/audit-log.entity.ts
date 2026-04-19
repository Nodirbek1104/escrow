import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { User } from '../../user/entities/user.entity';

@Entity('audit_logs')
export class AuditLog {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'int', nullable: true, name: 'userId' })
  userId!: number | null;

  @Column({ type: 'varchar' })
  action!: string;

  @Column({ type: 'varchar' })
  status!: string;

  @Column({ type: 'int', nullable: true })
  deviceId!: number | null;

  @Column({ type: 'varchar', nullable: true })
  ipAddress!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  headers!: any;

  @CreateDateColumn()
  createdAt!: Date;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'userId' })
  user!: User | null;
}