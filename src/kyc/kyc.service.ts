import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../user/entities/user.entity';
import { KycDocument, KycDocType } from './kyc-document.entity';
import { NotificationsService } from '../notifications/notifications.service';

const REQUIRED_TYPES: KycDocType[] = ['id_front', 'id_back', 'selfie'];

@Injectable()
export class KycService {
  private readonly logger = new Logger(KycService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(KycDocument)
    private readonly docRepo: Repository<KycDocument>,
    private readonly notifications: NotificationsService,
  ) {}

  async getStatus(userId: number) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('Foydalanuvchi topilmadi');
    const docs = await this.latestDocsByType(userId);
    return {
      status: user.kycStatus ?? 'unverified',
      rejectionReason: user.kycRejectionReason ?? null,
      submittedAt: user.kycSubmittedAt ?? null,
      reviewedAt: user.kycReviewedAt ?? null,
      documents: docs,
    };
  }

  /** Persist freshly uploaded documents and move the user to PENDING. */
  async submit(
    userId: number,
    files: Partial<Record<KycDocType, Express.Multer.File>>,
  ) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('Foydalanuvchi topilmadi');
    if (user.kycStatus === 'approved') {
      throw new BadRequestException('Sizning hisobingiz allaqachon tasdiqlangan');
    }

    // Each new submission overrides the previous one — clear out earlier rows.
    // (Keeping rows would bloat the review UI; audit trail can be reintroduced
    //  later via a soft-delete column.)
    await this.docRepo.delete({ userId });

    const saved: KycDocument[] = [];
    for (const type of REQUIRED_TYPES) {
      const file = files[type];
      if (!file) {
        throw new BadRequestException(`${type} fayl yuklanmadi`);
      }
      const row = this.docRepo.create({
        userId,
        type,
        fileUrl: `/api/kyc/file/${file.filename}`,
        fileName: file.originalname,
        size: file.size,
        mimeType: file.mimetype,
      });
      saved.push(await this.docRepo.save(row));
    }

    user.kycStatus = 'pending';
    user.kycRejectionReason = null;
    user.kycSubmittedAt = new Date();
    user.kycReviewedAt = null;
    user.kycReviewedBy = null;
    await this.userRepo.save(user);

    return { status: 'pending' as const, documents: saved };
  }

  // ─── Admin ───────────────────────────────────────────────────────────────
  async listPending() {
    const users = await this.userRepo.find({
      where: { kycStatus: 'pending' },
      order: { kycSubmittedAt: 'ASC' },
    });
    return users.map((u) => ({
      id: u.id,
      fullName: u.fullName,
      phoneNumber: u.phoneNumber,
      submittedAt: u.kycSubmittedAt,
    }));
  }

  async getForAdmin(userId: number) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('Foydalanuvchi topilmadi');
    const docs = await this.latestDocsByType(userId);
    return {
      user: {
        id: user.id,
        fullName: user.fullName,
        phoneNumber: user.phoneNumber,
        role: user.role,
        kycStatus: user.kycStatus,
        rejectionReason: user.kycRejectionReason,
        submittedAt: user.kycSubmittedAt,
        reviewedAt: user.kycReviewedAt,
        reviewedBy: user.kycReviewedBy,
      },
      documents: docs,
    };
  }

  async approve(userId: number, adminId: number) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('Foydalanuvchi topilmadi');
    if (user.kycStatus !== 'pending') {
      throw new BadRequestException(
        'Faqat pending holatdagi yuborishni tasdiqlash mumkin',
      );
    }
    user.kycStatus = 'approved';
    user.kycRejectionReason = null;
    user.kycReviewedAt = new Date();
    user.kycReviewedBy = adminId;
    await this.userRepo.save(user);
    await this.notifications
      .create(
        userId,
        'KYC tasdiqlandi',
        'Hisobingiz muvaffaqiyatli tasdiqlandi.',
        'kyc_approved',
        String(userId),
      )
      .catch((e) => this.logger.warn(`KYC approve notify: ${(e as Error).message}`));
    return { status: 'approved' as const };
  }

  async reject(userId: number, adminId: number, reason: string) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('Foydalanuvchi topilmadi');
    if (user.kycStatus !== 'pending') {
      throw new BadRequestException(
        'Faqat pending holatdagi yuborishni rad etish mumkin',
      );
    }
    if (!reason || !reason.trim()) {
      throw new BadRequestException('Rad etish sababi kerak');
    }
    user.kycStatus = 'rejected';
    user.kycRejectionReason = reason.trim();
    user.kycReviewedAt = new Date();
    user.kycReviewedBy = adminId;
    await this.userRepo.save(user);
    await this.notifications
      .create(
        userId,
        'KYC rad etildi',
        `Sabab: ${reason.trim()}. Iltimos, hujjatlarni qaytadan yuklang.`,
        'kyc_rejected',
        String(userId),
      )
      .catch((e) => this.logger.warn(`KYC reject notify: ${(e as Error).message}`));
    return { status: 'rejected' as const, reason: reason.trim() };
  }

  // ─── Internal ────────────────────────────────────────────────────────────
  private async latestDocsByType(userId: number) {
    const rows = await this.docRepo.find({
      where: { userId },
      order: { uploadedAt: 'DESC' },
    });
    const byType = new Map<KycDocType, KycDocument>();
    for (const r of rows) {
      if (!byType.has(r.type)) byType.set(r.type, r);
    }
    return Array.from(byType.values());
  }
}
