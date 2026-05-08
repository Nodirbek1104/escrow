import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { User } from '../../user/entities/user.entity';
import { EscrowContract } from '../../escrocontracts/entities/escrocontract.entity';

export type MessageType = 'user' | 'system';

@Entity()
export class Message {
  @PrimaryGeneratedColumn()
  id: number;

  @Column('text')
  content: string;

  @Column({ nullable: true })
  fileUrl: string;

  /** Quoted message id; loaded lazily so list query joins it cheaply. */
  @Column({ type: 'integer', nullable: true })
  replyToId?: number | null;

  @ManyToOne(() => Message, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'replyToId' })
  replyTo?: Message | null;

  /** Set when the sender edits this message; FE shows "(tahrirlandi)". */
  @Column({ type: 'timestamp', nullable: true })
  editedAt?: Date | null;

  /** Soft-delete: row stays for audit, content is wiped on delete. */
  @Column({ type: 'timestamp', nullable: true })
  deletedAt?: Date | null;

  /**
   * 'user' = a real participant message (default)
   * 'system' = auto-generated note about a status change
   *   Rendered centered with no avatar; senderId may be 0/null.
   */
  @Column({ type: 'varchar', default: 'user' })
  type!: MessageType;

  /** For system messages: { kind: 'status_change', from, to, contractId, ... } */
  @Column({ type: 'jsonb', nullable: true })
  systemPayload?: Record<string, any> | null;

  @ManyToOne(() => EscrowContract, (contract) => contract.id)
  contract: EscrowContract;

  @Column()
  contractId: number;

  @ManyToOne(() => User, { nullable: true })
  sender: User;

  /** 0 for system messages with no sender. */
  @Column({ default: 0 })
  senderId: number;

  @CreateDateColumn()
  createdAt: Date;
}
