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

  /**
   * BUG-L16: Password reset / "log out everywhere" uchun. Har JWT
   * payload'da `tokenVersion` saqlanadi va validate'da DB versiyasi bilan
   * solishtiriladi. Reset paytida bu raqam +1, eski tokenlar darhol
   * yaroqsiz bo'ladi.
   */
  @Column({ type: 'integer', default: 0 })
  tokenVersion!: number;

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

  // Telegram WebApp user.id — set when the user opens the Mini-App and we can
  // verify their initData. Lets us re-issue a JWT without phone+OTP next time.
  @Column({ type: "bigint", nullable: true, unique: true })
  telegramId?: string | null;

  // KYC verification flow. 'unverified' = never submitted, 'pending' =
  // submitted and awaiting admin review, 'approved' = admin verified,
  // 'rejected' = admin rejected (rejectionReason explains why).
  @Column({ type: "varchar", default: "unverified" })
  kycStatus!: "unverified" | "pending" | "approved" | "rejected";

  @Column({ type: "varchar", nullable: true })
  kycRejectionReason?: string | null;

  @Column({ type: "timestamp", nullable: true })
  kycSubmittedAt?: Date | null;

  @Column({ type: "timestamp", nullable: true })
  kycReviewedAt?: Date | null;

  @Column({ type: "integer", nullable: true })
  kycReviewedBy?: number | null;

  // Profil rasmi — yuklangan avatarning serve URL'i (masalan
  // `/auth/avatar/file/<name>.jpg`). Null = rasm yo'q (initiallar ko'rsatiladi).
  @Column({ type: "varchar", nullable: true })
  avatarUrl?: string | null;

  // --- RELATIONLAR ---
  
  @OneToMany(() => EscrowContract, (contract) => contract.creator)
  createdContracts!: EscrowContract[];

  // Kartalar bilan bog'liqlik
  @OneToMany(() => Card, (card) => card.user)
  cards!: Card[];

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  createdAt!: Date;

  // ─── Preferences (Profile → Settings) ─────────────────────────────────
  /** Master switch for push notifications (FCM + Telegram). */
  @Column({ type: 'boolean', default: true })
  pushEnabled!: boolean;

  /** Specific channels — granular control. All default ON. */
  @Column({ type: 'boolean', default: true })
  notifChat!: boolean;

  @Column({ type: 'boolean', default: true })
  notifContract!: boolean;

  @Column({ type: 'boolean', default: true })
  notifPayment!: boolean;

  @Column({ type: 'boolean', default: false })
  notifMarketing!: boolean;

  /** Quiet hours window — HH:MM strings, e.g. "22:00" and "08:00". Null
   * means no quiet hours. */
  @Column({ type: 'varchar', length: 5, nullable: true })
  quietFrom?: string | null;

  @Column({ type: 'varchar', length: 5, nullable: true })
  quietTo?: string | null;

  /** UI language preference: 'uz', 'uz-cyr', 'ru', 'en'. */
  @Column({ type: 'varchar', length: 8, default: 'uz' })
  locale!: string;
}