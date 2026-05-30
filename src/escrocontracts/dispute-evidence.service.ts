import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DisputeEvidence } from './dispute-evidence.entity';
import { EscrowContract, EscrowStatus } from './entities/escrocontract.entity';
import { User } from '../user/entities/user.entity';

const ALLOWED_STATUSES_FOR_UPLOAD: EscrowStatus[] = [
  EscrowStatus.PAYMENT_HELD,
  EscrowStatus.ACTIVE,
  EscrowStatus.DISPUTED,
];

@Injectable()
export class DisputeEvidenceService {
  constructor(
    @InjectRepository(DisputeEvidence)
    private readonly evidenceRepo: Repository<DisputeEvidence>,
    @InjectRepository(EscrowContract)
    private readonly contractRepo: Repository<EscrowContract>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  async upload(
    contractId: number,
    userId: number,
    file: Express.Multer.File,
    note?: string,
  ): Promise<DisputeEvidence> {
    if (!file) {
      throw new BadRequestException('Fayl yuklanmadi');
    }
    const contract = await this.requireParticipantAccess(contractId, userId);
    if (!ALLOWED_STATUSES_FOR_UPLOAD.includes(contract.status)) {
      throw new BadRequestException(
        'Isbot faqat to‘langan, faol yoki nizodagi shartnomaga yuklanadi',
      );
    }
    const row = this.evidenceRepo.create({
      contractId,
      userId,
      fileUrl: `/api/escrow-contracts/evidence/file/${file.filename}`,
      fileName: file.originalname,
      size: file.size,
      mimeType: file.mimetype,
      note: note?.trim() || null,
    });
    return this.evidenceRepo.save(row);
  }

  /** Visible to participants and admins. */
  async list(contractId: number, user: any): Promise<any[]> {
    await this.requireAccess(contractId, user);
    const rows = await this.evidenceRepo.find({
      where: { contractId, deleted: false },
      order: { uploadedAt: 'ASC' },
    });
    if (rows.length === 0) return [];
    const userIds = Array.from(new Set(rows.map((r) => r.userId)));
    const users = await this.userRepo.find({
      where: userIds.map((id) => ({ id })),
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    return rows.map((r) => ({
      ...r,
      uploader: byId.get(r.userId)
        ? {
            id: r.userId,
            fullName: byId.get(r.userId)!.fullName,
            phoneNumber: byId.get(r.userId)!.phoneNumber,
          }
        : { id: r.userId, fullName: null, phoneNumber: null },
    }));
  }

  async softDelete(
    contractId: number,
    evidenceId: string,
    userId: number,
  ): Promise<{ ok: true }> {
    const evidence = await this.evidenceRepo.findOne({
      where: { id: evidenceId, contractId },
    });
    if (!evidence) throw new NotFoundException('Isbot topilmadi');
    if (evidence.userId !== userId) {
      throw new ForbiddenException('Faqat o‘z isbotingizni o‘chirishingiz mumkin');
    }
    evidence.deleted = true;
    await this.evidenceRepo.save(evidence);
    return { ok: true };
  }

  // ─── helpers ─────────────────────────────────────────────────────────────
  private async requireAccess(
    contractId: number,
    user: any,
  ): Promise<EscrowContract> {
    const contract = await this.contractRepo.findOne({
      where: { id: contractId },
    });
    if (!contract) throw new NotFoundException('Shartnoma topilmadi');
    const isAdmin = user.role === 'admin' || user.role === 'super_admin';
    const isParticipant =
      contract.creatorId === user.userId ||
      contract.executorId === user.userId ||
      contract.executorPhoneNumber === user.phoneNumber;
    if (!isAdmin && !isParticipant) {
      // IDOR-safe: don't reveal that the contract exists at all to a
      // non-participant — return the same 404 they'd see for a bogus id.
      throw new NotFoundException('Shartnoma topilmadi');
    }
    return contract;
  }

  private async requireParticipantAccess(
    contractId: number,
    userId: number,
  ): Promise<EscrowContract> {
    const contract = await this.contractRepo.findOne({
      where: { id: contractId },
    });
    if (!contract) throw new NotFoundException('Shartnoma topilmadi');
    const isParticipant =
      contract.creatorId === userId || contract.executorId === userId;
    if (!isParticipant) {
      // Phone-based fallback for executors who haven't accepted yet still
      // shouldn't be uploading evidence — leave them out.
      throw new ForbiddenException(
        'Faqat shartnoma ishtirokchilari isbot yuklay oladi',
      );
    }
    return contract;
  }
}
