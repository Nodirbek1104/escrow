// src/escrocontracts/escrocontracts.service.ts
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Inject,
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



const INVITE_TTL  = 60 * 60 * 24; // 24 soat
const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:3000';

interface JwtUser {
  userId: number;
  phoneNumber: string;
  role?: string;
}

interface InvitePayload {
  contractId: number;
  phone: string;
}

@Injectable()
export class EscrocontractsService {
  constructor(
    @InjectRepository(EscrowContract)
    private readonly contractRepo: Repository<EscrowContract>,

    @InjectRepository(User)
    private readonly userRepo: Repository<User>,


    private readonly smsService: SmsService,
    // constructor ichida
   @InjectRedis()
    private readonly redis: Redis,
  ) {}

  // ─── 1. Shartnoma yaratish ─────────────────────────────────────────────────
  async create(
    dto: CreateEscrowContractDto,
    user: JwtUser,
    filePath?: string,
  ): Promise<EscrowContract & { inviteToken?: string }> {
    const contract = this.contractRepo.create({
      title: dto.title,
      amount: dto.amount,
      deadline: dto.deadline,
      executorPhoneNumber: dto.executorPhoneNumber,
      technicalTermsFile: filePath ?? undefined,
      status: EscrowStatus.PENDING,
      creator: { id: user.userId } as any,
    });
    

    const saved = await this.contractRepo.save(contract);

    // SMS yuborish + token generatsiya
    const token = await this.sendInviteSms(saved.id, dto.executorPhoneNumber);

    // Development'da token response'da ham ko'rsatiladi (Postman test uchun)
    return {
      ...saved,
      inviteToken: process.env.NODE_ENV === 'development' ? token : undefined,
    };
  }

  // ─── SMS yuborish (private) ────────────────────────────────────────────────
 // sendInviteSms metodini biroz xavfsizroq qilamiz
private async sendInviteSms(contractId: number, phone: string): Promise<string> {
  const token = uuidv4();
  const payload: InvitePayload = { contractId, phone };

  await this.redis.setex(
    `contract_invite:${token}`,
    INVITE_TTL,
    JSON.stringify(payload),
  );

  const link = `${FRONTEND_URL}/invite/${token}`;
  const message = `Sizga shartnoma yuborildi. Ko'rish uchun: ${link}`;

  try {
    await this.smsService.send(phone, message);
  } catch (error) {
    // Agar SMS ketmasa, log qilamiz, lekin shartnoma yaratilishini to'xtatmaymiz
    console.error('SMS yuborishda xatolik:', error);
  }

  return token;
}

  // ─── 2. Invite token tekshirish ────────────────────────────────────────────
  async resolveInvite(token: string): Promise<{
    action: 'register' | 'view';
    contractId: number;
    token: string;
  }> {
    const raw = await this.redis.get(`contract_invite:${token}`);

    if (!raw) {
      throw new BadRequestException("Link muddati o'tgan yoki noto'g'ri");
    }

    const payload: InvitePayload = JSON.parse(raw);

    const user = await this.userRepo.findOne({
      where: { phoneNumber: payload.phone },
    });

    if (!user) {
      return { action: 'register', contractId: payload.contractId, token };
    }

    return { action: 'view', contractId: payload.contractId, token };
  }
async getContractByToken(token: string, user: JwtUser): Promise<EscrowContract> {
  const raw = await this.redis.get(`contract_invite:${token}`);

  if (!raw) {
    throw new BadRequestException("Link muddati o'tgan yoki noto'g'ri");
  }

  const payload: InvitePayload = JSON.parse(raw);

  // ← shu qatorlarni qo'shing
  console.log('Token phone :', payload.phone);
  console.log('JWT phone   :', user.phoneNumber);
  console.log('Teng?       :', payload.phone === user.phoneNumber);

  const isAdmin    = user.role === 'admin';
  const isExecutor = payload.phone.replace('+', '') === user.phoneNumber.replace('+', '');

  if (!isExecutor && !isAdmin) {
    throw new ForbiddenException('Bu link sizga tegishli emas');
  }

  const contract = await this.contractRepo.findOne({
    where: { id: payload.contractId },
    relations: ['creator'],
  });

  if (!contract) throw new NotFoundException('Shartnoma topilmadi');

  return contract;
}
  // ─── 4. Foydalanuvchi shartnomalar ro'yxati ───────────────────────────────
  async findAllByUser(user: JwtUser): Promise<EscrowContract[]> {
    return this.contractRepo.find({
      where: [
        { creator: { id: user.userId } },
        { executorPhoneNumber: user.phoneNumber },
      ],
      relations: ['creator'],
      order: { createdAt: 'DESC' },
    });
  }

  // ─── 5. Bittasini ko'rish ──────────────────────────────────────────────────
  async findOne(id: number, user: JwtUser): Promise<EscrowContract> {
    const contract = await this.contractRepo.findOne({
      where: { id },
      relations: ['creator'],
    });

    if (!contract) throw new NotFoundException('Shartnoma topilmadi');

    const isCreator  = contract.creator?.id === user.userId;
    const isExecutor = contract.executorPhoneNumber === user.phoneNumber;
    const isAdmin    = user.role === 'admin';

    if (!isCreator && !isExecutor && !isAdmin) {
      throw new ForbiddenException("Sizda bu shartnomani ko'rishga ruxsat yo'q");
    }

    return contract;
  }

  // ─── 6. Status yangilash ──────────────────────────────────────────────────
  async updateStatus(
    id: number,
    status: EscrowStatus,
    user: JwtUser,
    reason?: string,
  ): Promise<EscrowContract> {
    const contract = await this.findOne(id, user);

    if (
      status === EscrowStatus.ACCEPTED &&
      contract.executorPhoneNumber !== user.phoneNumber
    ) {
      throw new ForbiddenException('Faqat ijrochi shartnomani tasdiqlashi mumkin');
    }

    if (
      (status === EscrowStatus.REJECTED || status === EscrowStatus.REVISION) &&
      !reason
    ) {
      throw new BadRequestException("Sabab ko'rsatish majburiy");
    }

    contract.status = status;
    contract.rejectionReason = reason ?? null;

    return this.contractRepo.save(contract);
  }

  // ─── 7. Tahrirlash ────────────────────────────────────────────────────────
  async update(
    id: number,
    dto: Partial<CreateEscrowContractDto>,
    user: JwtUser,
    filePath?: string,
  ): Promise<EscrowContract> {
    const contract = await this.findOne(id, user);

    if (contract.creator.id !== user.userId) {
      throw new ForbiddenException('Faqat shartnoma egasi tahrirlashi mumkin');
    }

    const editableStatuses = [
      EscrowStatus.PENDING,
      EscrowStatus.REVISION,
      EscrowStatus.REJECTED,
    ];

    if (!editableStatuses.includes(contract.status)) {
      throw new BadRequestException(
        'Qabul qilingan yoki yakunlangan shartnomani tahrirlash mumkin emas',
      );
    }

    if (dto.title)               contract.title               = dto.title;
    if (dto.amount)              contract.amount              = dto.amount;
    if (dto.deadline)            contract.deadline            = dto.deadline;
    if (dto.executorPhoneNumber) contract.executorPhoneNumber = dto.executorPhoneNumber;
    if (filePath)                contract.technicalTermsFile  = filePath;

    contract.status          = EscrowStatus.PENDING;
    contract.rejectionReason = null;

    return this.contractRepo.save(contract);
  }

  // ─── 8. Bekor qilish ──────────────────────────────────────────────────────
  async cancel(id: number, user: JwtUser): Promise<EscrowContract> {
    const contract = await this.findOne(id, user);

    if (contract.creator.id !== user.userId) {
      throw new ForbiddenException('Faqat shartnoma egasi uni bekor qila oladi');
    }

    const cancellableStatuses = [EscrowStatus.PENDING, EscrowStatus.REVISION];

    if (!cancellableStatuses.includes(contract.status)) {
      throw new BadRequestException(
        "Boshlangan yoki yakunlangan bitimni bekor qilib bo'lmaydi",
      );
    }

    contract.status = EscrowStatus.CANCELLED;
    return this.contractRepo.save(contract);
  }
}