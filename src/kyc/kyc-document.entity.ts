import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
  CreateDateColumn,
} from 'typeorm';

export type KycDocType = 'id_front' | 'id_back' | 'selfie';

/**
 * One uploaded KYC document. A user typically submits three of these
 * (id front, id back, selfie). The most recent row per (userId, type)
 * is the active version; older rows stay for audit.
 */
@Entity('kyc_documents')
@Index(['userId'])
@Index(['userId', 'type'])
export class KycDocument {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  userId!: number;

  @Column({ type: 'varchar' })
  type!: KycDocType;

  /** Public URL the FE can render (always served via /api/kyc/file/...). */
  @Column()
  fileUrl!: string;

  @Column()
  fileName!: string;

  @Column({ type: 'integer' })
  size!: number;

  @Column()
  mimeType!: string;

  @CreateDateColumn()
  uploadedAt!: Date;
}
