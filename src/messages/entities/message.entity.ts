import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne } from 'typeorm';
import { User } from '../../user/entities/user.entity';
import { Escrocontract } from '../../escrocontracts/entities/escrocontract.entity';

@Entity()
export class Message {
  @PrimaryGeneratedColumn()
  id: number;

  @Column('text')
  content: string;

  @Column({ nullable: true })
  fileUrl: string;

  @ManyToOne(() => Escrocontract, (contract) => contract.id)
  contract: Escrocontract;

  @Column()
  contractId: number;

  @ManyToOne(() => User)
  sender: User;

  @Column()
  senderId: number;

  @CreateDateColumn()
  createdAt: Date;
}
