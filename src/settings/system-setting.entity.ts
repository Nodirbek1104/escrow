import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * Key/value store for runtime-tunable settings (commission percent,
 * limits, SMS templates, ...). Edited from the admin panel; cached in
 * memory by SettingsService for fast synchronous reads.
 */
@Entity('system_settings')
export class SystemSetting {
  @PrimaryColumn()
  key!: string;

  @Column({ type: 'text' })
  value!: string;

  @Column({ type: 'text', nullable: true })
  description?: string | null;

  @UpdateDateColumn()
  updatedAt!: Date;
}
