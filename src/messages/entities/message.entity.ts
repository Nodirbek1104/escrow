import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne } from 'typeorm';
import { User } from '../../user/entities/user.entity';
import { EscrowContract } from '../../escrocontracts/entities/escrocontract.entity';

@Entity()
export class Message {
  @PrimaryGeneratedColumn()
  id: number;

  @Column('text')
  content: string;

  @Column({ nullable: true })
  fileUrl: string;

  @ManyToOne(() => EscrowContract, (contract) => contract.id)
  contract: EscrowContract;

  @Column()
  contractId: number;

  @ManyToOne(() => User)
  sender: User;

  @Column()
  senderId: number;

  @CreateDateColumn()
  createdAt: Date;
}
