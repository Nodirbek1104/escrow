import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { User } from './user.entity';

@Entity('user_devices')
export class UserDevice {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  userId!: number;

  @Column()
  fingerprint!: string; // Qurilmaning unikal identifikatori (Frontend'dan keladi)

  @Column({ nullable: true })
  model!: string; // Masalan: iPhone 13 Pro, Pixel 7

  @Column({ nullable: true })
  os!: string; // iOS, Android, macOS, Windows

  @Column({ nullable: true })
  osVersion!: string; // Masalan: 17.4.1

  @Column({ nullable: true })
  appVersion!: string; // Ilovangizning versiyasi (masalan: 1.0.2)

  @Column({ nullable: true })
  ipAddress!: string;

  @CreateDateColumn()
  lastLogin!: Date;

  @ManyToOne(() => User, (user) => user.id, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user!: User;
}