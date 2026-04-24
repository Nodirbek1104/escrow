import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { EscrowContract, EscrowStatus } from './entities/escrocontract.entity';
import { CreateEscrowContractDto } from './dto/create-escrocontract.dto';
import { User } from '../user/entities/user.entity';
import { SmsService } from '../sms/sms.service';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { PaymentService } from '../payment/payment.service';

const INVITE_TTL = 60 * 60 * 24;
const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:3000';

@Injectable()
export class EscrocontractsService {
  private readonly logger = new Logger(EscrocontractsService.name);

  constructor(
    @InjectRepository(EscrowContract)
    private readonly contractRepo: Repository<EscrowContract>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly smsService: SmsService,
    private readonly paymentService: PaymentService,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  // ─── 1. CREATE ─────────────────────────────────────────────────────────────
  async create(dto: CreateEscrowContractDto, user: any, filePath?: string) {
    const contract = this.contractRepo.create({
      ...dto,
      technicalTermsFile: filePath,
      status: EscrowStatus.PENDING,
      creatorId: user.userId,
    });

    const saved = await this.contractRepo.save(contract);
    const token = await this.sendInviteSms(saved.id, dto.executorPhoneNumber);

    return { ...saved, inviteToken: token };
  }

  // ─── 2. INVITE RESOLVE ─────────────────────────────────────────────────────
  async resolveInvite(token: string) {
    const raw = await this.redis.get(`contract_invite:${token}`);
    if (!raw) throw new BadRequestException("Link muddati o'tgan");

    const payload = JSON.parse(raw);
    const user = await this.userRepo.findOne({ where: { phoneNumber: payload.phone } });

    return {
      action: user ? 'view' : 'register',
      contractId: payload.contractId,
      token,
    };
  }

  async getContractByToken(token: string, user: any) {
    const raw = await this.redis.get(`contract_invite:${token}`);
    if (!raw) throw new BadRequestException("Link muddati o'tgan");

    const payload = JSON.parse(raw);
    if (payload.phone.replace('+', '') !== user.phoneNumber.replace('+', '')) {
      throw new ForbiddenException('Bu link sizga tegishli emas');
    }

    return this.findOne(payload.contractId, user);
  }

  // ─── 3. FIND ALL ───────────────────────────────────────────────────────────
  async findAllByUser(user: any) {
    return this.contractRepo.find({
      where: [
        { creatorId: user.userId },
        { executorPhoneNumber: user.phoneNumber },
      ],
      relations: ['creator'],
      order: { createdAt: 'DESC' },
    });
  }

  // ─── 4. UPDATE STATUS & PAYMENT ────────────────────────────────────────────
  async updateStatus(
    id: number,
    status: EscrowStatus,
    user: any,
    data?: { reason?: string; cardId?: string },
  ) {
    const contract = await this.findOne(id, user);
    this.validateStatusTransition(contract.status, status);

    if (status === EscrowStatus.ACCEPTED) {
      if (contract.executorPhoneNumber !== user.phoneNumber) throw new ForbiddenException('Faqat ijrochi uchun');
      if (!data?.cardId) throw new BadRequestException('Karta ID kerak');
      contract.receiverCardId = data.cardId;
      contract.executorId = user.userId;
    }

    if (status === EscrowStatus.COMPLETED) {
      if (contract.creatorId !== user.userId) throw new ForbiddenException('Faqat xaridor uchun');
      const res = await this.paymentService.fulfillEscrow(contract.transactionId!, contract.receiverCardId!);
      if (!res.result) throw new BadRequestException('To‘lov xatosi');
    }

    contract.status = status;
    if (data?.reason) contract.rejectionReason = data.reason;
    return this.contractRepo.save(contract);
  }

  async holdContractPayment(id: number, user: any, cardId: string) {
    const contract = await this.findOne(id, user);
    const holdResult = await this.paymentService.holdFunds(user.userId, cardId, contract.amount, contract.id.toString());

    if (holdResult.result?.transactionId) {
      contract.transactionId = holdResult.result.transactionId;
      contract.senderCardId = cardId;
      contract.status = EscrowStatus.PAYMENT_HELD;
      return this.contractRepo.save(contract);
    }
    throw new BadRequestException('Muzlatishda xato');
  }

  // ─── 5. UPDATE (TAHRIRLASH) ────────────────────────────────────────────────
  async update(id: number, dto: any, user: any, filePath?: string) {
    const contract = await this.findOne(id, user);
    if (contract.creatorId !== user.userId) throw new ForbiddenException('Ruxsat yo‘q');
    
    Object.assign(contract, dto);
    if (filePath) contract.technicalTermsFile = filePath;
    return this.contractRepo.save(contract);
  }

  async cancel(id: number, user: any) {
    const contract = await this.findOne(id, user);
    if (contract.status === EscrowStatus.PAYMENT_HELD) {
      await this.paymentService.cancelTransaction(contract.transactionId!);
    }
    contract.status = EscrowStatus.CANCELLED;
    return this.contractRepo.save(contract);
  }

  async findOne(id: number, user: any): Promise<EscrowContract> {
    const contract = await this.contractRepo.findOne({ where: { id }, relations: ['creator'] });
    if (!contract) throw new NotFoundException('Topilmadi');
    return contract;
  }

  private async sendInviteSms(contractId: number, phone: string) {
    const token = uuidv4();
    await this.redis.setex(`contract_invite:${token}`, INVITE_TTL, JSON.stringify({ contractId, phone }));
    try { await this.smsService.send(phone, `Shartnoma linki: ${FRONTEND_URL}/invite/${token}`); } catch (e) {}
    return token;
  }

  private validateStatusTransition(current: EscrowStatus, next: EscrowStatus) {
    // Soddalashtirilgan tekshiruv (yoki yuqoridagi rules'ni ishlating)
    if (current === EscrowStatus.COMPLETED || current === EscrowStatus.CANCELLED) {
      throw new BadRequestException('Yopilgan shartnomani o‘zgartirib bo‘lmaydi');
    }
  }
}