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
import { NotificationsService } from '../notifications/notifications.service';
import {
  computeCommission,
  getCommissionPercent,
  totalCharge,
} from './commission';
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
    private readonly notificationsService: NotificationsService,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  // ─── 1. CREATE (IJROCHI TOMONIDAN) ──────────────────────────────────────────
  async create(dto: CreateEscrowContractDto, user: any, filePath?: string) {
    try {
      const commissionAmount = computeCommission(Number(dto.amount));
      const contract = this.contractRepo.create({
        ...dto,
        commissionAmount,
        technicalTermsFile: filePath,
        status: EscrowStatus.PENDING,
        creatorId: user.userId, // Creator = xaridor (buyer); ijrochi taklif qilinadi
      });

      const saved = await this.contractRepo.save(contract);
      const token = await this.sendInviteSms(saved, dto.executorPhoneNumber);
      const inviteLink = `${FRONTEND_URL}/invite/${token}`;

      // Notify creator (Success)
      await this.notificationsService.create(
        user.userId,
        "Shartnoma yaratildi",
        `#ESC-${saved.id} raqamli shartnoma muvaffaqiyatli yaratildi. Ijrochi tasdiqlashini kuting.`,
        "contract_created",
        saved.id.toString()
      );

      return { ...saved, inviteToken: token, inviteLink };
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

      const contract = await this.contractRepo.findOne({ where: { id: payload.contractId } });

      return {
        action: user ? 'login' : 'register',
        contractId: payload.contractId,
        phoneNumber: payload.phone,
        token,
        contract: contract ? {
          title: contract.title,
          amount: contract.amount,
        } : null
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

      // QOIDALAR: Xaridor (Creator) ACCEPTED qilganda pul majburiy muzlatiladi
      if (status === EscrowStatus.ACCEPTED && user.userId === contract.creatorId) {
        if (!data?.cardId) {
          throw new BadRequestException('Shartnomani tasdiqlash uchun karta kiritish shart!');
        }

        // Buyer kartasidan jami summa (kontrakt + komissiya) muzlatiladi.
        const total = totalCharge(contract.amount, contract.commissionAmount);
        const holdResult = await this.paymentService.holdFunds(
          user.userId,
          data.cardId,
          total,
          contract.id.toString(),
        );

        if (holdResult?.result?.transactionId) {
          contract.transactionId = holdResult.result.transactionId;
          contract.senderCardId = data.cardId;
          contract.status = EscrowStatus.PAYMENT_HELD; // Avtomatik HELD holatiga o'tadi
        } else {
          const errMsg = holdResult?.error?.message || 'Kartada mablag\'ni muzlatishda xatolik';
          this.logger.error(`Hold failed for contract ${contract.id}: ${JSON.stringify(holdResult?.error)}`);
          throw new BadRequestException(errMsg);
        }
      } else if (status === EscrowStatus.ACCEPTED) {
        // Ijrochi (sotuvchi) shartnomani qabul qilmoqda.
        if (!data?.cardId) {
          throw new BadRequestException('Shartnomani qabul qilish uchun pul tushadigan kartangizni tanlang!');
        }
        // Faqat taklif qilingan ijrochining o'zi qabul qila oladi.
        const userPhone = String(user.phoneNumber ?? '').replace(/\D/g, '');
        const inviteePhone = String(contract.executorPhoneNumber ?? '').replace(/\D/g, '');
        if (userPhone !== inviteePhone) {
          throw new ForbiddenException("Siz bu shartnomaning ijrochisi emassiz");
        }
        // Karta ijrochiga tegishli ekanligini tekshiramiz.
        const myCardsResp = await this.paymentService.getMyCards(user.userId);
        const myCards = myCardsResp?.result?.cards ?? [];
        const ownsCard = myCards.some((c: any) => c.cardId === data.cardId);
        if (!ownsCard) {
          throw new ForbiddenException('Tanlangan karta sizga tegishli emas');
        }
        contract.receiverCardId = data.cardId;
        contract.executorId = user.userId; // notification + ownership audit
        contract.status = EscrowStatus.ACCEPTED;
      }

      // Shartnoma yakunlanganda pulni o'tkazish
      if (status === EscrowStatus.COMPLETED) {
        const isAdmin = user.role === 'admin' || user.role === 'super_admin';
        if (!isAdmin && contract.creatorId !== user.userId) {
          throw new ForbiddenException('Faqat xaridor yoki Admin yopishi mumkin');
        }
        if (!contract.transactionId) {
          throw new BadRequestException('Bu shartnomada muzlatilgan tranzaksiya yo\'q');
        }
        if (!contract.receiverCardId) {
          throw new BadRequestException('Ijrochining kartasi belgilanmagan, payout amalga oshmaydi');
        }

        // 1) Hold'ni merchant hisobiga to'liq charge qilamiz (jami summa).
        const total = totalCharge(contract.amount, contract.commissionAmount);
        const chargeRes = await this.paymentService.fulfillEscrow(
          contract.transactionId,
          total,
        );
        if (!chargeRes?.result) {
          const errMsg = chargeRes?.error?.message || 'To\'lovni amalga oshirishda xatolik';
          throw new BadRequestException(errMsg);
        }

        // 2) Merchant hisobidan ijrochi kartasiga sof summa payout.
        // Komissiya merchant'da qoladi.
        const payoutRes = await this.paymentService.payoutToCard(
          contract.receiverCardId,
          contract.amount,
          contract.id.toString(),
        );
        if (!payoutRes?.result) {
          const errMsg =
            payoutRes?.error?.message ||
            'Charge muvaffaqiyatli, lekin ijrochiga payout amalga oshmadi. Admin aralashishi kerak.';
          this.logger.error(
            `Payout failed for contract ${contract.id}: ${JSON.stringify(payoutRes?.error)}`,
          );
          // Shartnomani DISPUTED'ga o'tkazamiz va admin ko'rib chiqsin
          contract.status = EscrowStatus.DISPUTED;
          contract.rejectionReason = `Payout xatosi: ${errMsg}`;
          await this.contractRepo.save(contract);
          throw new BadRequestException(errMsg);
        }

        contract.status = EscrowStatus.COMPLETED;
      }

      if (data?.reason) contract.rejectionReason = data.reason;

      if (status === EscrowStatus.DISPUTED) {
        if (!data?.reason) {
          throw new BadRequestException('Nizo ochish uchun sabab ko‘rsatish shart!');
        }
        contract.status = EscrowStatus.DISPUTED;
      }
      
      const savedContract = await this.contractRepo.save(contract);

      // Trigger Notifications
      const targetUserId = (user.userId === savedContract.creatorId) ? savedContract.executorId : savedContract.creatorId;
      if (targetUserId) {
        await this.notificationsService.create(
          targetUserId,
          "Shartnoma holati o'zgardi",
          `#ESC-${savedContract.id} shartnomasi "${status}" holatiga o'tkazildi.`,
          "contract_update",
          savedContract.id.toString()
        );
      }

      return savedContract;
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
        relations: ['creator'],
      });
      if (!contract) throw new NotFoundException('Shartnoma topilmadi');

      // Admin bo'lsa hamma shartnomani ko'ra oladi
      const isAdmin = user.role === 'admin' || user.role === 'super_admin';
      if (!isAdmin && contract.creatorId !== user.userId && contract.executorPhoneNumber !== user.phoneNumber) {
         // Agar shartnoma tarafi bo'lmasa, ko'rish taqiqlanadi
         throw new ForbiddenException('Sizda ushbu shartnomani ko‘rish huquqi yo‘q');
      }

      return this.withCommissionMeta(contract);
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      throw new BadRequestException('Maʼlumotni olishda xato');
    }
  }

  /** Attach commissionPercent + totalAmount to the response (computed). */
  private withCommissionMeta(contract: EscrowContract): any {
    return {
      ...contract,
      commissionPercent: getCommissionPercent(),
      totalAmount: totalCharge(contract.amount, contract.commissionAmount),
    };
  }

  // ─── 5. BEKOR QILISH (UNHOLD BILAN) ────────────────────────────────────────
  async cancel(id: number, user: any) {
    try {
      const contract = await this.findOne(id, user);
      
      const isAdmin = user.role === 'admin' || user.role === 'super_admin';
      if (!isAdmin && contract.creatorId !== user.userId) {
        throw new ForbiddenException('Bekor qilish huquqi yo‘q');
      }
      
      if (contract.status === EscrowStatus.PAYMENT_HELD) {
        // Pul muzlatilgan bo'lsa, uni yechib yuboramiz (unhold)
        await this.paymentService.cancelHold(contract.transactionId!);
      }
      
      contract.status = EscrowStatus.CANCELLED;
      return await this.contractRepo.save(contract);
    } catch (error) {
      this.logger.error(`Cancel Error: ${error}`);
      throw error;
    }
  }

  // ─── YORDAMCHI METODLAR ───────────────────────────────────────────────────
  private async sendInviteSms(contract: EscrowContract, phone: string) {
    const token = uuidv4();
    await this.redis.setex(
      `contract_invite:${token}`,
      INVITE_TTL,
      JSON.stringify({ contractId: contract.id, phone }),
    );

    const inviteLink = `${FRONTEND_URL}/invite/${token}`;
    const amountFmt = new Intl.NumberFormat('uz-UZ').format(
      Math.round(contract.amount),
    );
    const message =
      `ESCRO platformasida sizga "${contract.title}" shartnomasi taklif qilindi (${amountFmt} so'm). ` +
      `Tasdiqlash uchun: ${inviteLink}`;

    this.logger.log(`Invite link for ${phone}: ${inviteLink}`);

    try {
      await this.smsService.send(phone, message);
    } catch (error) {
      this.logger.warn(
        `SMS jo'natilmadi (${phone}): ${(error as Error).message}. Invite link API javobida qaytariladi.`,
      );
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

  // 1. O'zgaruvchilarni xavfsiz olish (String() va ?. ishlatish)
  // Bu yerda payload.phone yoki user.phoneNumber bo'lmasa, replace ishga tushmaydi
  const payloadPhone = payload?.phone ? String(payload.phone).replace(/\D/g, '') : null;
  const userPhone = user?.phoneNumber ? String(user.phoneNumber).replace(/\D/g, '') : null;

  // 2. Agar foydalanuvchida raqam bo'lmasa, aniq xato beramiz
  if (!userPhone) {
    this.logger.error(`Foydalanuvchi ob'ektida phoneNumber topilmadi: ${JSON.stringify(user)}`);
    throw new ForbiddenException("Profilingizda telefon raqami ko'rsatilmagan (JWT xatosi)");
  }

  // 3. Agar Redis dagi payloadda raqam bo'lmasa
  if (!payloadPhone) {
    throw new BadRequestException("Link ma'lumotlari buzilgan yoki telefon raqami topilmadi");
  }

  if (payloadPhone !== userPhone) {
    throw new ForbiddenException('Bu link boshqa telefon raqamiga tegishli');
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

  async findAllAdmin() {
    return this.contractRepo.find({
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