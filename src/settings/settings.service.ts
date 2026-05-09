import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SystemSetting } from './system-setting.entity';

const DEFAULT_SETTINGS: Array<{
  key: string;
  value: string;
  description: string;
}> = [
  {
    key: 'platform_commission_percent',
    value: '5',
    description: 'Platforma komissiyasi foizi (har kontraktdagi summa ustiga qo\'shiladi)',
  },
  {
    key: 'min_contract_amount',
    value: '500',
    description: 'Minimal kontrakt summasi (so\'m)',
  },
  {
    key: 'max_contract_amount',
    value: '100000000',
    description: 'Maksimal kontrakt summasi (so\'m)',
  },
  {
    key: 'default_contract_term_days',
    value: '28',
    description: 'Qisqa muddatli kontrakt uchun standart muddat (kun)',
  },
];

@Injectable()
export class SettingsService implements OnModuleInit {
  private readonly logger = new Logger(SettingsService.name);
  private cache = new Map<string, string>();

  constructor(
    @InjectRepository(SystemSetting)
    private readonly repo: Repository<SystemSetting>,
  ) {}

  async onModuleInit() {
    await this.refresh();
    // Seed defaults for any keys that are missing.
    for (const def of DEFAULT_SETTINGS) {
      if (!this.cache.has(def.key)) {
        await this.set(def.key, def.value, def.description);
      }
    }
  }

  /** Pull all rows into the in-memory cache (call once on boot, again on write). */
  async refresh(): Promise<void> {
    const all = await this.repo.find();
    this.cache.clear();
    for (const s of all) this.cache.set(s.key, s.value);
  }

  getString(key: string, fallback = ''): string {
    return this.cache.get(key) ?? fallback;
  }

  getNumber(key: string, fallback = 0): number {
    const v = this.cache.get(key);
    if (v === undefined) return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  /** Persist a setting (admin only) and update the cache atomically. */
  async set(
    key: string,
    value: string,
    description?: string,
  ): Promise<SystemSetting> {
    let row = await this.repo.findOne({ where: { key } });
    if (!row) {
      row = this.repo.create({
        key,
        value,
        description: description ?? null,
      });
    } else {
      row.value = value;
      if (description !== undefined && description !== null) {
        row.description = description;
      }
    }
    const saved = await this.repo.save(row);
    this.cache.set(key, value);
    return saved;
  }

  async getAll(): Promise<SystemSetting[]> {
    return this.repo.find({ order: { key: 'ASC' } });
  }

  // ─── Specific helpers ───────────────────────────────────────────────────
  /** Commission percent: cache → env (PLATFORM_COMMISSION_PERCENT) → 5. */
  getCommissionPercent(): number {
    const fromCache = this.getNumber('platform_commission_percent', NaN);
    if (Number.isFinite(fromCache) && fromCache >= 0 && fromCache <= 100) {
      return fromCache;
    }
    const fromEnv = Number(process.env.PLATFORM_COMMISSION_PERCENT);
    if (Number.isFinite(fromEnv) && fromEnv >= 0 && fromEnv <= 100) {
      return fromEnv;
    }
    return 5;
  }
}
