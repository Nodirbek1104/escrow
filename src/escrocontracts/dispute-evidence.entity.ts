import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
  CreateDateColumn,
} from 'typeorm';

/**
 * One piece of evidence (file, image, or note) uploaded by a contract
 * participant during a dispute. Visible to the other participant and to
 * admins. Soft-delete column lets the uploader retract before the dispute
 * is resolved without losing the audit trail.
 */
@Entity('dispute_evidence')
@Index(['contractId'])
@Index(['contractId', 'userId'])
export class DisputeEvidence {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  contractId!: number;

  @Column()
  userId!: number;

  @Column()
  fileUrl!: string;

  @Column()
  fileName!: string;

  @Column({ type: 'integer' })
  size!: number;

  @Column()
  mimeType!: string;

  @Column({ type: 'text', nullable: true })
  note?: string | null;

  @Column({ default: false })
  deleted!: boolean;

  @CreateDateColumn()
  uploadedAt!: Date;
}
