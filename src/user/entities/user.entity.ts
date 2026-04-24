import { Entity, PrimaryGeneratedColumn, Column, OneToMany } from "typeorm";
import { EscrowContract } from "../../escrocontracts/entities/escrocontract.entity";
import { Card } from "../../payment/entities/payment.entity"; // Card entityni import qiling

export enum UserRole {
  USER = 'user',
  ADMIN = 'admin',
  SUPER_ADMIN = 'super_admin',
}

@Entity()
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ unique: true })
  phoneNumber!: string;

  @Column({ nullable: true })
  fullName!: string;

  @Column({ select: false, nullable: true })
  password!: string;

  @Column({ default: false })
  isVerified!: boolean;

  @Column({
    type: "enum",
    enum: UserRole,
    default: UserRole.USER,
  })
  role!: UserRole;

  @Column({ type: "varchar", nullable: true })
  otpCode?: string | null;

  @Column({ type: "timestamp", nullable: true })
  otpExpires?: Date | null;

  // --- RELATIONLAR ---
  
  @OneToMany(() => EscrowContract, (contract) => contract.creator)
  createdContracts!: EscrowContract[];

  // Kartalar bilan bog'liqlik
  @OneToMany(() => Card, (card) => card.user)
  cards!: Card[];

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  createdAt!: Date;
}