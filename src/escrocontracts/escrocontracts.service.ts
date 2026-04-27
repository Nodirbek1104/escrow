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
import { SmsService } from '../user/send.sms.service'; 
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { PaymentService } from '../payment/payment.service';
import { error } from 'console';

const INVITE_TTL = 60 * 60 * 24; // 24 soat
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

  // ─── 1. CREATE (IJROCHI TOMONIDAN) ──────────────────────────────────────────
  async create(dto: CreateEscrowContractDto, user: any, filePath?: string) {
    try {
      const contract = this.contractRepo.create({
        ...dto,
        technicalTermsFile: filePath,
        status: EscrowStatus.PENDING,
        creatorId: user.userId, // Shartnomani boshlagan odam (ijrochi)
      });

      const saved = await this.contractRepo.save(contract);
      const token = await this.sendInviteSms(saved.id, dto.executorPhoneNumber);
      
      return { ...saved, inviteToken: token };
    } catch (error) {
      this.logger.error(`Create Error: ${error}`);
      throw error;
    }
  }

  // ─── 2. INVITE RESOLVE (XARIDOR LINKNI BOSGANDA) ───────────────────────────
  async resolveInvite(token: string) {
    try {
      const raw = await this.redis.get(`contract_invite:${token}`);
      if (!raw) throw new BadRequestException("Link muddati o'tgan yoki xato");

      const payload = JSON.parse(raw);
      const user = await this.userRepo.findOne({ where: { phoneNumber: payload.phone } });

      return {
        action: user ? 'login' : 'register',
        contractId: payload.contractId,
        phoneNumber: payload.phone,
        token,
      };
    } catch (error) {
      this.logger.error(`ResolveInvite Error: ${error}`);
      throw error;
    }
  }

  // ─── 3. STATUSNI YANGILASH VA AVTOMATIK HOLD ──────────────────────────────
  async updateStatus(
    id: number,
    status: EscrowStatus,
    user: any,
    data?: { reason?: string; cardId?: string },
  ) {
    try {
      const contract = await this.findOne(id, user);
      this.validateStatusTransition(contract.status, status);

      // QOIDALAR: Xaridor ACCEPTED qilganda pul majburiy muzlatiladi
      if (status === EscrowStatus.ACCEPTED) {
        if (!data?.cardId) {
          throw new BadRequestException('Shartnomani tasdiqlash uchun karta kiritish shart!');
        }

        // To'lovni muzlatish (Hold) jarayoni
        const holdResult = await this.paymentService.holdFunds(
          user.userId, 
          data.cardId, 
          contract.amount, 
          contract.id.toString()
        );

        if (holdResult.result?.transactionId) {
          contract.transactionId = holdResult.result.transactionId;
          contract.senderCardId = data.cardId;
          contract.status = EscrowStatus.PAYMENT_HELD; // Avtomatik HELD holatiga o'tadi
          contract.executorId = user.userId; // Xaridorni bog'laymiz
        } else {
          throw new BadRequestException('Kartada mablag‘ yetarli emas yoki hold jarayonida xatolik!');
        }
      }

      // Shartnoma yakunlanganda pulni o'tkazish
      if (status === EscrowStatus.COMPLETED) {
        if (contract.creatorId !== user.userId) throw new ForbiddenException('Faqat ijrochi/xaridor yopishi mumkin');
        
        const res = await this.paymentService.fulfillEscrow(contract.transactionId!, contract.receiverCardId!);
        if (!res.result) throw new BadRequestException('To‘lovni amalga oshirishda xatolik');
        contract.status = EscrowStatus.COMPLETED;
      }

      if (data?.reason) contract.rejectionReason = data.reason;
      
      return await this.contractRepo.save(contract);
    } catch (error) {
      this.logger.error(`UpdateStatus Error: ${error}`);
      throw error;
    }
  }

  // ─── 4. FIND ONE (XATOLIKLAR BILAN) ────────────────────────────────────────
  async findOne(id: number, user: any): Promise<EscrowContract> {
    try {
      const contract = await this.contractRepo.findOne({ 
        where: { id }, 
        relations: ['creator'] 
      });
      if (!contract) throw new NotFoundException('Shartnoma topilmadi');
      return contract;
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      throw new BadRequestException('Maʼlumotni olishda xato');
    }
  }

  // ─── 5. BEKOR QILISH (UNHOLD BILAN) ────────────────────────────────────────
  async cancel(id: number, user: any) {
    try {
      const contract = await this.findOne(id, user);
      
      if (contract.status === EscrowStatus.PAYMENT_HELD) {
        // Pul muzlatilgan bo'lsa, uni yechib yuboramiz (unhold)
        await this.paymentService.cancelTransaction(contract.transactionId!);
      }
      
      contract.status = EscrowStatus.CANCELLED;
      return await this.contractRepo.save(contract);
    } catch (error) {
      this.logger.error(`Cancel Error: ${error}`);
      throw error;
    }
  }

  // ─── YORDAMCHI METODLAR ───────────────────────────────────────────────────
  private async sendInviteSms(contractId: number, phone: string) {
    const token = uuidv4();
    await this.redis.setex(`contract_invite:${token}`, INVITE_TTL, JSON.stringify({ contractId, phone }));
    
    const inviteLink = `${FRONTEND_URL}/invite/${token}`;
    try { 
      await this.smsService.send(phone, `Bu Eskiz dan test`); 
    } catch (error) {
      this.logger.error(`SMS yuborishda xato: ${error}`);
    }
    return token;
  }

  private validateStatusTransition(current: EscrowStatus, next: EscrowStatus) {
    if (current === EscrowStatus.COMPLETED || current === EscrowStatus.CANCELLED) {
      throw new BadRequestException('Yopilgan shartnomani o‘zgartirib bo‘lmaydi');
    }
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
  // ─── UPDATE METODI ─────────────────────────────────────────────────────────
async update(id: number, dto: any, user: any, filePath?: string) {
  try {
    // Avval shartnomani topamiz va ruxsatni tekshiramiz
    const contract = await this.findOne(id, user);

    // Faqat shartnoma yaratuvchisi (creator) uni tahrirlay olishi mumkin
    if (contract.creatorId !== user.userId) {
      throw new ForbiddenException('Sizda ushbu shartnomani tahrirlash huquqi yo‘q');
    }

    // Faqat PENDING holatidagi shartnomani tahrirlash mumkin deb hisoblasak:
    if (contract.status !== EscrowStatus.PENDING) {
      throw new BadRequestException('Faqat kutilayotgan (PENDING) shartnomalarni tahrirlash mumkin');
    }

    // DTO dagi ma'lumotlarni contract obyektiga o'tkazamiz
    Object.assign(contract, dto);

    // Agar yangi fayl yuklangan bo'lsa, uni yangilaymiz
    if (filePath) {
      contract.technicalTermsFile = filePath;
    }

    return await this.contractRepo.save(contract);
  } catch (error) {
    this.logger.error(`Update Error: ${error}`);
    throw error;
  }
}
}