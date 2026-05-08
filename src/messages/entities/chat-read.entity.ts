import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Unique,
  Index,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Per-user, per-contract read pointer. Stores the timestamp of the most
 * recently read message; the inbox `unreadCount` is messages from the
 * other party newer than this. Granular per-message read receipts will
 * come in Chat-2 (separate MessageRead table).
 */
@Entity('chat_reads')
@Unique(['userId', 'contractId'])
@Index(['userId'])
export class ChatRead {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  userId!: number;

  @Column()
  contractId!: number;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  lastReadAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
