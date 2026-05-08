import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne } from 'typeorm';
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
