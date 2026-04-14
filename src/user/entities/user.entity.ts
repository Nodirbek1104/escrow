// import { Entity, PrimaryGeneratedColumn, Column } from "typeorm";

// @Entity()
// export class User {
//   @PrimaryGeneratedColumn()
//   id!: number;

//   @Column({ unique: true })
//   phoneNumber!: string;

//   @Column({ nullable: true })
//   fullName!: string;

//   @Column({ select: false, nullable: true }) // Xavfsizlik uchun select qilganda chiqmaydi
//   password!: string;

//   @Column({ default: false })
//   isVerified!: boolean;

//   @Column({ type:"varchar", nullable: true })
//   otpCode?: string|null; // nullable bo'lgani uchun '?' ishlatsa ham bo'ladi

//   @Column({ type: "timestamp", nullable: true })
//   otpExpires?: Date|null;

// }
// export enum UserRole {
//   USER = 'user',
//   ADMIN = 'admin',
//   SUPER_ADMIN = 'super_admin', // Eng yuqori huquq
// }

import { Entity, PrimaryGeneratedColumn, Column, OneToMany } from "typeorm";
import { EscrowContract } from "../../escrocontracts/entities/escrocontract.entity";

// Enumni klassdan tashqarida (tepada) saqlash yaxshi amaliyot
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

  // --- MUHIM: Role ustuni shu yerda bo'lishi kerak ---
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

  @OneToMany(() => EscrowContract, (contract) => contract.creator)
createdContracts!: EscrowContract[];

  // Vaqtni kuzatish uchun bu ustunlarni qo'shish tavsiya etiladi
  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  createdAt!: Date;
}