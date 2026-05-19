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
import {
  ContractType,
  EscrowContract,
  EscrowStatus,
} from './entities/escrocontract.entity';
import { CreateEscrowContractDto } from './dto/create-escrocontract.dto';
import { User, UserRole } from '../user/entities/user.entity';
import { SmsService } from '../user/send.sms.service'; 
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { PaymentService } from '../payment/payment.service';
import { mapPaylovError } from '../payment/utils/paylov-error-map';
import { NotificationsService } from '../notifications/notifications.service';
import { MessagesGateway } from '../messages/messages.gateway';
import { MessagesService } from '../messages/messages.service';
import { SettingsService } from '../settings/settings.service';
import { computeCommission, totalCharge } from './commission';
import { buildCsv } from '../common/csv';
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
    private readonly messagesGateway: MessagesGateway,
    private readonly messagesService: MessagesService,
    private readonly settings: SettingsService,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  // ─── ROLE HELPERS ────────────────────────────────────────────────────────
  /** Buyer userId for either flow: creator if buyer-created, otherwise the
   *  invitee that has already accepted. May be null if invitee not registered. */
  private getBuyerId(c: EscrowContract): number | null {
    return c.contractType === ContractType.EXECUTOR_INITIATED
      ? (c.executorId ?? null)
      : c.creatorId;
  }

  /** Executor userId for either flow: creator if executor-created, otherwise
   *  the invitee that has already accepted. */
  private getExecutorId(c: EscrowContract): number | null {
    return c.contractType === ContractType.EXECUTOR_INITIATED
      ? c.creatorId
      : (c.executorId ?? null);
  }

/** True when `user` is the buyer of this contract (creator or invitee). */
private isBuyerActing(c: EscrowContract, user: any): boolean {
  // Buyer-created: creator = buyer
  if (c.contractType === ContractType.BUYER_INITIATED) {
    return user.userId === c.creatorId;
  }
  
  // Executor-created: invitee = buyer
  // 1. Allaqachon qo'shilgan (executorId mavjud)
  if (c.executorId) {
    return user.userId === c.executorId;
  }
  
  // 2. Hali qo'shilmagan, telefon orqali aniqlash
  return this.isInviteeByPhone(c, user);
}

/** True when `user` is the executor of this contract. */
private isExecutorActing(c: EscrowContract, user: any): boolean {
  // Executor-created: creator = executor
  if (c.contractType === ContractType.EXECUTOR_INITIATED) {
    return user.userId === c.creatorId;
  }
  
  // Buyer-created: invitee = executor
  // 1. Allaqachon qo'shilgan
  if (c.executorId) {
    return user.userId === c.executorId;
  }
  
  // 2. Hali qo'shilmagan, telefon orqali aniqlash
  return this.isInviteeByPhone(c, user);
}

/** Helper: check if user matches the invitee phone */
private isInviteeByPhone(c: EscrowContract, user: any): boolean {
  if (!c.executorPhoneNumber || !user.phoneNumber) return false;
  return (
    this.normalizePhone(c.executorPhoneNumber) ===
    this.normalizePhone(user.phoneNumber)
  );
}

  /** System message text for the given new status; null = don't post one. */
  private systemMessageFor(status: string): string | null {
    switch (status) {
      case EscrowStatus.PENDING:
        return 'Shartnoma yaratildi. Ijrochi tasdiqlashini kuting.';
      case EscrowStatus.ACCEPTED:
        return 'Ijrochi shartnomani qabul qildi.';
      case EscrowStatus.PAYMENT_HELD:
        return "Xaridor mablag'ni muzlatdi. Ish kafolati ostida.";
      case EscrowStatus.ACTIVE:
        return 'Ish jarayoni boshlandi.';
      case EscrowStatus.COMPLETED:
        return "Shartnoma yakunlandi. Mablag' ijrochiga o'tkazildi.";
      case EscrowStatus.CANCELLED:
        return "Shartnoma bekor qilindi. Mablag' xaridorga qaytarildi.";
      case EscrowStatus.DISPUTED:
        // Suppressed here — postDisputeAdminAssigned() pushes a richer
        // system message naming the lead admin, so we'd get a duplicate.
        return null;
      case EscrowStatus.REJECTED:
        return 'Ijrochi shartnomani rad etdi.';
      case EscrowStatus.REVISION:
        return 'Shartnomani qayta ko\'rib chiqish so\'raldi.';
      default:
        return null;
    }
  }

  /**
   * Pick the admin to take lead on a fresh dispute. Round-robin by current
   * active assignments: admin with the fewest in-flight DISPUTED contracts
   * wins; ties broken by user id for determinism. Returns null when no
   * admin is registered.
   */
  private async pickAdminForDispute(): Promise<User | null> {
    const admins = await this.userRepo.find({
      where: [{ role: UserRole.ADMIN }, { role: UserRole.SUPER_ADMIN }],
      order: { id: 'ASC' },
    });
    if (admins.length === 0) return null;
    const loads = await Promise.all(
      admins.map(async (a) => ({
        admin: a,
        load: await this.contractRepo.count({
          where: { assignedAdminId: a.id, status: EscrowStatus.DISPUTED },
        }),
      })),
    );
    loads.sort((a, b) => a.load - b.load || a.admin.id - b.admin.id);
    return loads[0]?.admin ?? null;
  }

  /**
   * Page admins when a dispute is opened. The `lead` admin (one assigned)
   * gets a personal "tayinlandi" notification; the rest get the broadcast
   * `dispute_admin` so anyone with capacity can still jump in. Best-effort.
   */
  private async notifyAdminsOfDispute(
    contract: EscrowContract,
    reason: string | undefined,
    lead: User | null,
  ): Promise<void> {
    const admins = await this.userRepo.find({
      where: [{ role: UserRole.ADMIN }, { role: UserRole.SUPER_ADMIN }],
      select: ['id'],
    });
    const tail = reason?.trim()
      ? ` Sabab: ${reason.trim().slice(0, 200)}`
      : '';
    for (const a of admins) {
      const isLead = lead?.id === a.id;
      await this.notificationsService
        .create(
          a.id,
          isLead ? 'Sizga nizo tayinlandi' : 'Yangi nizo',
          isLead
            ? `#ESC-${contract.id} "${contract.title}" sizga tayinlandi. Arbitraj boshlang.${tail}`
            : `#ESC-${contract.id} "${contract.title}" — arbitraj kerak.${tail}`,
          'dispute_admin',
          String(contract.id),
        )
        .catch(() => undefined);
    }
  }

  /**
   * Post a system bubble naming the lead admin so participants know who is
   * looking at their case. Falls back to the generic message if no admin
   * was assigned (e.g. system has no admin users).
   */
  private async postDisputeAdminAssigned(
    contractId: number,
    lead: User | null,
  ): Promise<void> {
    try {
      const text = lead?.fullName
        ? `Nizo ochildi. Admin ${lead.fullName} sizga yordam beradi.`
        : 'Nizo ochildi. Adminlar holatni ko\'rib chiqishadi.';
      const sys = await this.messagesService.createSystem(contractId, text, {
        kind: 'dispute_admin_assigned',
        adminId: lead?.id ?? null,
        adminName: lead?.fullName ?? null,
      });
      this.messagesGateway.emitToContract(contractId, 'newMessage', {
        ...sys,
        sender: { id: 0, fullName: 'System' },
      });
    } catch (e) {
      this.logger.warn(
        `postDisputeAdminAssigned failed: ${(e as Error).message}`,
      );
    }
  }

  private async emitContractUpdated(contract: { id: number; status: string }) {
    try {
      this.messagesGateway.emitToContract(contract.id, 'contractUpdated', {
        id: contract.id,
        status: contract.status,
        at: new Date().toISOString(),
      });

      // Persist + push a system bubble describing the change.
      const text = this.systemMessageFor(contract.status);
      if (text) {
        const sys = await this.messagesService.createSystem(
          contract.id,
          text,
          { kind: 'status_change', to: contract.status },
        );
        this.messagesGateway.emitToContract(contract.id, 'newMessage', {
          ...sys,
          sender: { id: 0, fullName: 'System' },
        });
      }
    } catch (e) {
      this.logger.warn(`emitContractUpdated failed: ${(e as Error).message}`);
    }
  }

  // ─── 1. CREATE (IJROCHI TOMONIDAN) ──────────────────────────────────────────
  async create(dto: CreateEscrowContractDto, user: any, filePath?: string) {
    try {
      const commissionAmount = computeCommission(
        Number(dto.amount),
        this.settings.getCommissionPercent(),
      );
      const role = dto.contractType ?? ContractType.BUYER_INITIATED;

      // Escrow needs two distinct parties — refuse a contract where the
      // creator and the invitee are the same phone. Without this guard
      // a user can "sign" a contract with themselves, which both sides of
      // our role logic (isBuyerActing / isExecutorActing) then evaluate
      // to true and the UI breaks at runtime.
      const creatorPhoneDigits = this.normalizePhone(user.phoneNumber);
      const inviteePhoneDigits = this.normalizePhone(dto.executorPhoneNumber);
      if (
        creatorPhoneDigits &&
        inviteePhoneDigits &&
        creatorPhoneDigits === inviteePhoneDigits
      ) {
        throw new BadRequestException(
          "O'zingizga shartnoma yarata olmaysiz — boshqa tomon raqamini kiriting",
        );
      }

      // Executor-created (Offer) flow: creator pre-selects the payout card
      // because they're the one who will receive funds. Verify ownership.
      let receiverCardId: string | null = null;
      if (role === ContractType.EXECUTOR_INITIATED) {
        if (!dto.receiverCardId) {
          throw new BadRequestException(
            'Ijrochi sifatida yaratganda pul qabul qiluvchi kartani tanlash shart',
          );
        }
        const myCardsResp = await this.paymentService.getMyCards(user.userId);
        const myCards = myCardsResp?.result?.cards ?? [];
        if (!myCards.some((c: any) => c.cardId === dto.receiverCardId)) {
          throw new ForbiddenException('Tanlangan karta sizga tegishli emas');
        }
        receiverCardId = dto.receiverCardId;
      }

      const contract = this.contractRepo.create({
        title: dto.title,
        amount: dto.amount,
        deadline: dto.deadline,
        executorPhoneNumber: dto.executorPhoneNumber,
        commissionAmount,
        technicalTermsFile: filePath,
        status: EscrowStatus.PENDING,
        creatorId: user.userId,
        contractType: role,
        // For executor-created contracts, the creator IS the executor and
        // their receiver card is known up front. The `executorId` column
        // here is reused as "invitee user id", so it stays NULL until the
        // buyer registers/accepts.
        ...(receiverCardId ? { receiverCardId } : {}),
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

      // Genesis system message in the contract chat
      await this.emitContractUpdated(saved);

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

      // ACCEPTED transition has two distinct meanings depending on who is
      // acting and the contract's creatorRole:
      //   1. Buyer acting → fund the escrow (hold). Works for both flows.
      //      In buyer-created: creator is buyer; executor must already have
      //      set receiverCardId.
      //      In executor-created: invitee is buyer; receiverCardId was set
      //      at create time; we record buyer's userId on executorId slot.
      //   2. Executor acting (only meaningful in buyer-created flow):
      //      pre-pay step where executor picks the receiver card.
      if (status === EscrowStatus.ACCEPTED && this.isBuyerActing(contract, user)) {
        if (!data?.cardId) {
          throw new BadRequestException('Shartnomani tasdiqlash uchun karta kiritish shart!');
        }
        if (contract.contractType === ContractType.BUYER_INITIATED && !contract.receiverCardId) {
          throw new BadRequestException(
            "Avval ijrochi pul qabul qiluvchi kartani tanlashi kerak",
          );
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
          // For executor-created flow, this is also the moment the buyer
          // joins the contract — record their userId on the invitee slot.
          if (contract.contractType === ContractType.EXECUTOR_INITIATED && !contract.executorId) {
            contract.executorId = user.userId;
          }
          contract.status = EscrowStatus.PAYMENT_HELD;
        } else {
          const mapped = mapPaylovError({
            code: holdResult?.error?.code,
            message: holdResult?.error?.message,
          });
          this.logger.error(
            `Hold failed for contract ${contract.id} [${mapped.category}]: ${JSON.stringify(holdResult?.error)}`,
          );
          // Throw a structured BadRequest so the FE can render a specific
          // error block (e.g. "balans yetarli emas") rather than a toast.
          throw new BadRequestException({
            statusCode: 400,
            message: mapped.title,
            errorCategory: mapped.category,
            hint: mapped.hint,
            paylov: mapped.raw,
          });
        }
      } else if (status === EscrowStatus.ACCEPTED && this.isExecutorActing(contract, user)) {
        // Executor accepting + setting receiver card (buyer-created flow).
        if (contract.contractType === ContractType.EXECUTOR_INITIATED) {
          throw new BadRequestException("Bu shartnomada qabul qilish bosqichi yo'q — xaridor to'lashini kuting");
        }
        if (!data?.cardId) {
          throw new BadRequestException('Shartnomani qabul qilish uchun pul tushadigan kartangizni tanlang!');
        }
        const myCardsResp = await this.paymentService.getMyCards(user.userId);
        const myCards = myCardsResp?.result?.cards ?? [];
        const ownsCard = myCards.some((c: any) => c.cardId === data.cardId);
        if (!ownsCard) {
          throw new ForbiddenException('Tanlangan karta sizga tegishli emas');
        }
        contract.receiverCardId = data.cardId;
        contract.executorId = user.userId;
        contract.status = EscrowStatus.ACCEPTED;
      }

      // Shartnoma yakunlanganda pulni o'tkazish
      if (status === EscrowStatus.COMPLETED) {
        const isAdmin = user.role === 'admin' || user.role === 'super_admin';
        const buyerId = this.getBuyerId(contract);
        if (!isAdmin && buyerId !== user.userId) {
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
          // Shartnomani DISPUTED'ga o'tkazamiz va admin ko'rib chiqsin.
          // Same auto-assign + chat-announce flow as a user-opened dispute,
          // otherwise the failure silently rots in the queue.
          contract.status = EscrowStatus.DISPUTED;
          contract.rejectionReason = `Payout xatosi: ${errMsg}`;
          let payoutDisputeLead: User | null = null;
          if (!contract.assignedAdminId) {
            payoutDisputeLead = await this.pickAdminForDispute();
            if (payoutDisputeLead) {
              contract.assignedAdminId = payoutDisputeLead.id;
            }
          }
          const failedContract = await this.contractRepo.save(contract);
          await this.notifyAdminsOfDispute(
            failedContract,
            `Payout xatosi: ${errMsg}`,
            payoutDisputeLead,
          ).catch((e) =>
            this.logger.warn(`Admin escalation failed: ${e?.message}`),
          );
          await this.postDisputeAdminAssigned(failedContract.id, payoutDisputeLead);
          this.emitContractUpdated(failedContract);
          throw new BadRequestException(errMsg);
        }

        contract.status = EscrowStatus.COMPLETED;
      }

      if (data?.reason) contract.rejectionReason = data.reason;

      let disputeLead: User | null = null;
      if (status === EscrowStatus.DISPUTED) {
        if (!data?.reason) {
          throw new BadRequestException('Nizo ochish uchun sabab ko‘rsatish shart!');
        }
        contract.status = EscrowStatus.DISPUTED;
        // Round-robin assign so participants see a named admin and the
        // load is spread evenly across the team. Only set on first entry
        // into DISPUTED — re-disputes after admin action keep the same lead.
        if (!contract.assignedAdminId) {
          disputeLead = await this.pickAdminForDispute();
          if (disputeLead) {
            contract.assignedAdminId = disputeLead.id;
          }
        }
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

      // Auto-escalation: when a contract enters DISPUTED, page every admin
      // so somebody can pick up the arbitration. Done after participants
      // are notified so the admin push isn't blocked by their delivery.
      if (savedContract.status === EscrowStatus.DISPUTED) {
        await this.notifyAdminsOfDispute(
          savedContract,
          data?.reason,
          disputeLead,
        ).catch((e) =>
          this.logger.warn(`Admin escalation failed: ${e?.message}`),
        );
        // Drop a chat bubble naming the lead so participants don't sit in
        // the dark waiting for an unknown admin to appear.
        await this.postDisputeAdminAssigned(savedContract.id, disputeLead);
      }

      this.emitContractUpdated(savedContract);

      return savedContract;
    } catch (error) {
      this.logger.error(`UpdateStatus Error: ${error}`);
      throw error;
    }
  }
  async findOne(id: number, user: any): Promise<EscrowContract> {
  try {
    const contract = await this.contractRepo.findOne({
      where: { id },
      relations: ['creator', 'executor', 'assignedAdmin'],
    });
    if (!contract) throw new NotFoundException('Shartnoma topilmadi');

    const isAdmin = user.role === 'admin' || user.role === 'super_admin';
    const isCreator = contract.creatorId === user.userId;
    const isExecutor = !!contract.executorId && contract.executorId === user.userId;

    // Hali qo'shilmagan invitee — telefon orqali tekshirish
    let isPendingInvitee = false;
    if (!contract.executorId && contract.executorPhoneNumber && user.phoneNumber) {
      const contractPhone = this.normalizePhone(contract.executorPhoneNumber);
      const userPhone = this.normalizePhone(user.phoneNumber);
      isPendingInvitee = !!contractPhone && contractPhone === userPhone;
    }

    if (!isAdmin && !isCreator && !isExecutor && !isPendingInvitee) {
      throw new NotFoundException('Shartnoma topilmadi');
    }

    return this.withCommissionMeta(contract);
  } catch (error) {
    if (error instanceof NotFoundException) throw error;
    this.logger.error(`findOne error for contract ${id}: ${error}`);
    throw new BadRequestException('Ma\'lumotni olishda xato');
  }
}

async getContractByToken(token: string, user: any) {
  try {
    const raw = await this.redis.get(`contract_invite:${token}`);
    if (!raw) throw new BadRequestException("Link muddati o'tgan");

    let payload: { contractId?: number; phone?: string };
    try {
      payload = JSON.parse(raw);
    } catch {
      this.logger.error(`Invite payload buzilgan: ${raw}`);
      throw new BadRequestException("Link ma'lumotlari buzilgan");
    }

    if (!payload?.contractId) {
      throw new BadRequestException("Link ma'lumotlari to'liq emas");
    }

    if (!user?.phoneNumber) {
      this.logger.error(`User'da phoneNumber yo'q: ${JSON.stringify(user)}`);
      throw new ForbiddenException(
        "Profilingizda telefon raqami ko'rsatilmagan (JWT xatosi)",
      );
    }

    if (!payload.phone) {
      throw new BadRequestException("Link ma'lumotlari buzilgan");
    }

    // findOne bilan bir xil normalize logikasi
    const payloadPhone = this.normalizePhone(payload.phone);
    const userPhone = this.normalizePhone(user.phoneNumber);

    if (!payloadPhone || !userPhone || payloadPhone !== userPhone) {
      // IDOR-safe: boshqa user uchun "yaroqsiz" deb ko'rsatamiz
      throw new NotFoundException("Taklif yaroqsiz yoki muddati o'tgan");
    }

    return this.findOne(payload.contractId, user);
  } catch (error) {
    if (
      error instanceof BadRequestException ||
      error instanceof NotFoundException ||
      error instanceof ForbiddenException
    ) {
      throw error;
    }
    this.logger.error(`getContractByToken Error: ${error}`);
    throw new BadRequestException("Linkni tekshirishda xato");
  }
}

// Helper — class ichiga qo'shing
private normalizePhone(phone: string | null | undefined): string {
  if (!phone) return '';
  return phone.replace(/\D/g, '').slice(-9);
}
  /** Attach commissionPercent + totalAmount to the response (computed). */
  private withCommissionMeta(contract: EscrowContract): any {
    return {
      ...contract,
      commissionPercent: this.settings.getCommissionPercent(),
      totalAmount: totalCharge(contract.amount, contract.commissionAmount),
    };
  }

  /**
   * Admin-only: re-attempt a failed payout. Used when the auto-flow charged
   * funds successfully but the a2c payout to the executor's card failed
   * (which automatically marks the contract DISPUTED). The Paylov call is
   * idempotent via extId, so retrying is safe.
   */
  async retryPayout(id: number, user: any) {
    const contract = await this.findOne(id, user);
    const isAdmin = user.role === 'admin' || user.role === 'super_admin';
    if (!isAdmin) {
      throw new ForbiddenException('Faqat admin payoutni qayta urinishi mumkin');
    }
    if (contract.status !== EscrowStatus.DISPUTED) {
      throw new BadRequestException(
        'Payout retry faqat DISPUTED holatda ishlaydi',
      );
    }
    if (!contract.transactionId) {
      throw new BadRequestException(
        'Bu shartnomada charge tranzaksiyasi yo\'q (avval to\'lov muzlatilishi kerak)',
      );
    }
    if (!contract.receiverCardId) {
      throw new BadRequestException(
        'Ijrochining qabul qiluvchi kartasi belgilanmagan',
      );
    }

    const payoutRes = await this.paymentService.payoutToCard(
      contract.receiverCardId,
      contract.amount,
      contract.id.toString(),
    );
    if (!payoutRes?.result) {
      const errMsg = payoutRes?.error?.message || 'Payout retry muvaffaqiyatsiz';
      this.logger.error(
        `retryPayout failed for contract ${contract.id}: ${JSON.stringify(payoutRes?.error)}`,
      );
      contract.rejectionReason = `Payout retry xatosi: ${errMsg}`;
      await this.contractRepo.save(contract);
      throw new BadRequestException(errMsg);
    }

    contract.status = EscrowStatus.COMPLETED;
    contract.rejectionReason = null;
    const saved = await this.contractRepo.save(contract);

    // Notify both parties.
    const targets = [saved.creatorId, saved.executorId].filter(
      (uid): uid is number => typeof uid === 'number' && uid !== user.userId,
    );
    for (const targetUserId of targets) {
      await this.notificationsService.create(
        targetUserId,
        "Mablag' ijrochiga o'tkazildi",
        `#ESC-${saved.id} shartnomasi yakunlandi (admin tomonidan payout qayta urinildi).`,
        'contract_update',
        saved.id.toString(),
      );
    }

    await this.emitContractUpdated(saved);
    return saved;
  }

  // ─── 5. BEKOR QILISH (UNHOLD BILAN) ────────────────────────────────────────
  async cancel(id: number, user: any) {
    try {
      const contract = await this.findOne(id, user);
      const isAdmin = user.role === 'admin' || user.role === 'super_admin';

      // Idempotent: agar allaqachon CANCELLED bo'lsa, hech narsa qilmaymiz.
      if (contract.status === EscrowStatus.CANCELLED) {
        return contract;
      }

      // COMPLETED yoki boshqa terminal holatlardan bekor qilib bo'lmaydi.
      if (contract.status === EscrowStatus.COMPLETED) {
        throw new BadRequestException("Yakunlangan shartnomani bekor qilib bo'lmaydi");
      }

      // DISPUTED holatda faqat admin bekor qilib refund qila oladi.
      if (contract.status === EscrowStatus.DISPUTED && !isAdmin) {
        throw new ForbiddenException('Nizodagi shartnomani faqat admin bekor qiladi');
      }

      // Default: faqat xaridor bekor qila oladi (yoki admin).
      // Xaridor — kontraktning buyerId'si (creatorRole'ga qarab).
      const buyerId = this.getBuyerId(contract);
      if (!isAdmin && buyerId !== user.userId) {
        throw new ForbiddenException('Bekor qilish huquqi yo‘q');
      }

      // Hold mavjud bo'lsa, avval Paylov tomonida dismiss qilamiz; muvaffaqiyatsiz
      // bo'lsa kontrakt statusi o'zgarmaydi — pul Paylov'da muzlatilgan holicha
      // qoladi va admin qo'lda hal qilishi mumkin.
      const heldStates = [
        EscrowStatus.PAYMENT_HELD,
        EscrowStatus.ACTIVE,
        EscrowStatus.DISPUTED,
      ];
      if (heldStates.includes(contract.status) && contract.transactionId) {
        const dismissRes = await this.paymentService.cancelHold(
          contract.transactionId,
          contract.id,
        );
        if (!dismissRes?.result) {
          const errMsg =
            dismissRes?.error?.message ||
            "Paylov tomonida dismiss amalga oshmadi, holatda o'zgarish bo'lmadi";
          this.logger.error(
            `Cancel dismiss failed for contract ${contract.id}: ${JSON.stringify(dismissRes?.error)}`,
          );
          throw new BadRequestException(errMsg);
        }
      }

      contract.status = EscrowStatus.CANCELLED;
      const saved = await this.contractRepo.save(contract);

      // Ikki tarafni ham xabardor qilamiz.
      const targets = [saved.creatorId, saved.executorId].filter(
        (uid): uid is number => typeof uid === 'number' && uid !== user.userId,
      );
      for (const targetUserId of targets) {
        await this.notificationsService.create(
          targetUserId,
          'Shartnoma bekor qilindi',
          `#ESC-${saved.id} shartnomasi bekor qilindi.${
            heldStates.includes(saved.status) ? '' : ''
          }`,
          'contract_update',
          saved.id.toString(),
        );
      }

      this.emitContractUpdated(saved);

      return saved;
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

  /**
   * Allowed status transitions. Each key is the current status; the value
   * is the set of next statuses a request can ask for. Anything not listed
   * is rejected with 400, eliminating ad-hoc jumps (e.g. PENDING → COMPLETED)
   * that previously slipped through and left contracts in inconsistent
   * states. Terminal states (COMPLETED / CANCELLED / REJECTED) have no
   * outgoing edges.
   */
  private static readonly ALLOWED_TRANSITIONS: Record<EscrowStatus, EscrowStatus[]> = {
    [EscrowStatus.DRAFT]: [EscrowStatus.PENDING, EscrowStatus.CANCELLED],
    [EscrowStatus.PENDING]: [
      EscrowStatus.ACCEPTED,       // invitee accepts (buyer-created flow)
      EscrowStatus.PAYMENT_HELD,   // invitee pays directly (executor-created flow)
      EscrowStatus.REJECTED,
      EscrowStatus.CANCELLED,
    ],
    [EscrowStatus.ACCEPTED]: [
      EscrowStatus.PAYMENT_HELD,   // buyer pays
      EscrowStatus.CANCELLED,
    ],
    [EscrowStatus.PAYMENT_HELD]: [
      EscrowStatus.ACTIVE,         // work officially starts
      EscrowStatus.COMPLETED,      // buyer releases directly
      EscrowStatus.DISPUTED,
      EscrowStatus.CANCELLED,      // mutual cancel + refund
    ],
    [EscrowStatus.ACTIVE]: [
      EscrowStatus.COMPLETED,
      EscrowStatus.REVISION,
      EscrowStatus.DISPUTED,
      EscrowStatus.CANCELLED,
    ],
    [EscrowStatus.REVISION]: [
      EscrowStatus.ACTIVE,
      EscrowStatus.DISPUTED,
      EscrowStatus.CANCELLED,
    ],
    [EscrowStatus.DISPUTED]: [
      EscrowStatus.COMPLETED,      // admin force-completes
      EscrowStatus.CANCELLED,      // admin refunds
    ],
    [EscrowStatus.COMPLETED]: [],
    [EscrowStatus.CANCELLED]: [],
    [EscrowStatus.REJECTED]: [],
  };

  private validateStatusTransition(current: EscrowStatus, next: EscrowStatus) {
    if (current === next) {
      // Idempotent re-sends are confusing; force the caller to know.
      throw new BadRequestException(
        "Shartnoma allaqachon shu holatda — qayta yuborish kerakmas",
      );
    }
    const allowed = EscrocontractsService.ALLOWED_TRANSITIONS[current] ?? [];
    if (!allowed.includes(next)) {
      throw new BadRequestException(
        `"${current}" holatidan "${next}" holatiga o'tib bo'lmaydi`,
      );
    }
  }

  async findAllByUser(user: any) {
    return this.contractRepo.find({
      where: [
        { creatorId: user.userId },
        { executorPhoneNumber: user.phoneNumber },
      ],
      relations: ['creator', 'executor', 'assignedAdmin'],
      order: { createdAt: 'DESC' },
    });
  }

  async findAllAdmin() {
    return this.contractRepo.find({
      relations: ['creator', 'executor', 'assignedAdmin'],
      order: { createdAt: 'DESC' },
    });
  }

  /** Build a CSV string of all contracts in the given date window. */
  async exportContractsCsv(filters: { from?: string; to?: string; status?: string }): Promise<string> {
    const qb = this.contractRepo
      .createQueryBuilder('c')
      .leftJoinAndSelect('c.creator', 'creator')
      .orderBy('c.createdAt', 'DESC');
    if (filters.from) qb.andWhere('c."createdAt" >= :from', { from: filters.from });
    if (filters.to) qb.andWhere('c."createdAt" <= :to', { to: filters.to });
    if (filters.status) qb.andWhere('c.status = :status', { status: filters.status });
    const rows = await qb.getMany();

    const headers = [
      'id',
      'title',
      'status',
      'amount',
      'commission',
      'total',
      'creator_name',
      'creator_phone',
      'executor_phone',
      'executor_id',
      'paylov_tx_id',
      'sender_card',
      'receiver_card',
      'pinned_msg_id',
      'deadline_days',
      'created_at',
      'rejection_reason',
    ];
    const data = rows.map((c) => [
      c.id,
      c.title,
      c.status,
      Number(c.amount),
      Number(c.commissionAmount ?? 0),
      Number(c.amount) + Number(c.commissionAmount ?? 0),
      c.creator?.fullName ?? '',
      c.creator?.phoneNumber ?? '',
      c.executorPhoneNumber,
      c.executorId ?? '',
      c.transactionId ?? '',
      c.senderCardId ?? '',
      c.receiverCardId ?? '',
      c.pinnedMessageId ?? '',
      c.deadline ?? '',
      c.createdAt,
      c.rejectionReason ?? '',
    ]);
    return buildCsv(headers, data);
  }

  /**
   * Admin finance summary: how much money is currently parked in escrow,
   * how much commission has been earned vs is still pending, and a count
   * of contracts in each status.
   */
  async getFinanceSummary() {
    const all = await this.contractRepo.find({
      select: ['id', 'status', 'amount', 'commissionAmount'],
    });

    const heldStatuses = new Set([
      EscrowStatus.PAYMENT_HELD,
      EscrowStatus.ACTIVE,
      EscrowStatus.DISPUTED,
    ]);
    const settledStatuses = new Set([EscrowStatus.COMPLETED]);

    let heldAmount = 0; // amount + commission stuck in escrow
    let commissionPending = 0; // commission earnable on currently held contracts
    let commissionCollected = 0; // commission booked on completed contracts
    let activeContracts = 0;

    const statusCounts: Record<string, number> = {};

    for (const c of all) {
      const amt = Number(c.amount ?? 0);
      const com = Number(c.commissionAmount ?? 0);
      statusCounts[c.status] = (statusCounts[c.status] ?? 0) + 1;
      if (heldStatuses.has(c.status)) {
        heldAmount += amt + com;
        commissionPending += com;
        activeContracts += 1;
      } else if (settledStatuses.has(c.status)) {
        commissionCollected += com;
      }
    }

    return {
      heldAmount,
      commissionPending,
      commissionCollected,
      activeContracts,
      totalContracts: all.length,
      statusCounts,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Per-user analytics for the web-app dashboard. Counts contracts where
   * the user is buyer (money out) or executor (money in) over the last
   * `days` days, broken into daily buckets.
   *
   * `spent` is sourced from contracts the user paid into; `earned` is
   * what they received as the executor on completed contracts. `held`
   * is the live escrow balance (not in the time-series, just totals) for
   * contracts in payment_held / active / disputed.
   */
  async getMyAnalytics(user: any, days = 30) {
    const span = Math.max(1, Math.min(365, Number(days) || 30));
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    since.setUTCDate(since.getUTCDate() - (span - 1));

    const phoneDigits = String(user.phoneNumber ?? '').replace(/\D/g, '');

    // Pull every contract the user could be involved in (creator, executor
    // by id, or invitee by phone). Then we filter in JS using the role
    // helpers so this stays in sync with how the rest of the service
    // determines buyer vs executor.
    const candidates = await this.contractRepo
      .createQueryBuilder('c')
      .where('c."creatorId" = :uid', { uid: user.userId })
      .orWhere('c."executorId" = :uid', { uid: user.userId })
      .orWhere(
        `regexp_replace(c."executorPhoneNumber", '[^0-9]', '', 'g') = :phone`,
        { phone: phoneDigits },
      )
      .getMany();

    type Bucket = { date: string; spent: number; earned: number };
    const buckets = new Map<string, Bucket>();
    for (let i = 0; i < span; i++) {
      const d = new Date(since);
      d.setUTCDate(since.getUTCDate() + i);
      const key = d.toISOString().slice(0, 10);
      buckets.set(key, { date: key, spent: 0, earned: 0 });
    }

    let totalSpent = 0;
    let totalEarned = 0;
    let totalHeld = 0;
    let totalCommissionPaid = 0;
    let activeCount = 0;
    let completedCount = 0;
    let cancelledCount = 0;

    const heldStatuses = new Set([
      EscrowStatus.PAYMENT_HELD,
      EscrowStatus.ACTIVE,
      EscrowStatus.DISPUTED,
    ]);

    for (const c of candidates) {
      const isBuyer = this.isBuyerActing(c, user);
      const isExecutor = this.isExecutorActing(c, user);
      if (!isBuyer && !isExecutor) continue;

      const amt = Number(c.amount ?? 0);
      const com = Number(c.commissionAmount ?? 0);
      const createdKey = new Date(c.createdAt)
        .toISOString()
        .slice(0, 10);

      // Live held funds (only the buyer's money is at risk)
      if (heldStatuses.has(c.status)) {
        if (isBuyer) totalHeld += amt + com;
        activeCount++;
      } else if (c.status === EscrowStatus.COMPLETED) {
        completedCount++;
        if (isBuyer) {
          totalSpent += amt + com;
          totalCommissionPaid += com;
          const b = buckets.get(createdKey);
          if (b) b.spent += amt + com;
        }
        if (isExecutor) {
          totalEarned += amt;
          const b = buckets.get(createdKey);
          if (b) b.earned += amt;
        }
      } else if (c.status === EscrowStatus.CANCELLED) {
        cancelledCount++;
      }
    }

    return {
      days: span,
      from: since.toISOString().slice(0, 10),
      to: new Date().toISOString().slice(0, 10),
      series: Array.from(buckets.values()),
      totals: {
        spent: totalSpent,
        earned: totalEarned,
        held: totalHeld,
        commissionPaid: totalCommissionPaid,
        active: activeCount,
        completed: completedCount,
        cancelled: cancelledCount,
      },
    };
  }

  /**
   * Daily time-series for the admin Revenue Analytics dashboard. Buckets
   * the last `days` days by calendar date (UTC) and returns counts +
   * monetary sums per day. Empty days are filled with zeros so the chart
   * has a continuous x-axis.
   */
  async getRevenueAnalytics(days = 30) {
    const span = Math.max(1, Math.min(365, Number(days) || 30));
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    since.setUTCDate(since.getUTCDate() - (span - 1));

    const rows = await this.contractRepo
      .createQueryBuilder('c')
      .select('c.id', 'id')
      .addSelect('c.status', 'status')
      .addSelect('c.amount', 'amount')
      .addSelect('c."commissionAmount"', 'commissionAmount')
      .addSelect('c."createdAt"', 'createdAt')
      .where('c."createdAt" >= :since', { since })
      .getRawMany();

    type Bucket = {
      date: string;
      newContracts: number;
      completed: number;
      cancelled: number;
      volume: number; // sum of amount on contracts created that day
      commission: number; // sum of commissionAmount on completed contracts that day
    };

    const buckets = new Map<string, Bucket>();
    for (let i = 0; i < span; i++) {
      const d = new Date(since);
      d.setUTCDate(since.getUTCDate() + i);
      const key = d.toISOString().slice(0, 10);
      buckets.set(key, {
        date: key,
        newContracts: 0,
        completed: 0,
        cancelled: 0,
        volume: 0,
        commission: 0,
      });
    }

    let totalVolume = 0;
    let totalCommission = 0;
    let totalNew = 0;
    let totalCompleted = 0;
    let totalCancelled = 0;

    for (const r of rows) {
      const date = new Date(r.createdAt as Date).toISOString().slice(0, 10);
      const bucket = buckets.get(date);
      if (!bucket) continue;
      const amt = Number(r.amount ?? 0);
      const com = Number(r.commissionAmount ?? 0);
      bucket.newContracts += 1;
      bucket.volume += amt;
      totalNew += 1;
      totalVolume += amt;
      if (r.status === EscrowStatus.COMPLETED) {
        bucket.completed += 1;
        bucket.commission += com;
        totalCompleted += 1;
        totalCommission += com;
      } else if (r.status === EscrowStatus.CANCELLED) {
        bucket.cancelled += 1;
        totalCancelled += 1;
      }
    }

    return {
      days: span,
      from: since.toISOString().slice(0, 10),
      to: new Date().toISOString().slice(0, 10),
      series: Array.from(buckets.values()),
      totals: {
        newContracts: totalNew,
        completed: totalCompleted,
        cancelled: totalCancelled,
        volume: totalVolume,
        commission: totalCommission,
      },
    };
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