import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../user/entities/user.entity'; // User entity joylashgan yo'lni tekshiring

@Entity('cards')
export class Card {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ unique: true })
  cardId!: string; // Paylov tizimidagi cid (UUID formatida)

  // Foreign Key: User ID (User entitydagi id turi bilan bir xil bo'lishi shart)
  @Column()
  userId!: number;

  // Relation: Many cards to One User
  @ManyToOne(() => User, (user) => user.cards, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user!: User;

  @Column({ nullable: true })
  owner!: string;

  @Column({ nullable: true })
  cardName!: string;

  @Column()
  number!: string; // Maskalangan raqam: 860000******9999

  @Column({ type: 'bigint', default: 0 })
  balance!: number; // Tiynlarda saqlanadi

  @Column()
  expireDate!: string; // Format: 2612 (YYMM)

  @Column({ nullable: true })
  bankId!: string;

  @Column()
  vendor!: string; // Uzcard, Humo, MIR va h.k.

  @Column({ nullable: true })
  processing!: string;

  @Column({ default: true })
  isActive!: boolean;

  @Column({ nullable: true })
  statusMessage!: string;

  // Qo'shimcha: Karta qachon biriktirilganini bilish uchun
  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}