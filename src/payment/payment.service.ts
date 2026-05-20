import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { timingSafeEqual } from 'crypto';
import axios, { AxiosInstance } from 'axios';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { Card } from './entities/payment.entity';
import {
  PaymentTransaction,
  TransactionStatus,
  TransactionType,
} from './entities/transaction.entity';
import { EscrowContract } from '../escrocontracts/entities/escrocontract.entity';
import { handlePaymentError } from './utils/payment-error.handler';
import { auditContract } from './utils/contract-auditor';
import { buildCsv } from '../common/csv';
import { sumToTiyin, tiyinToSum, formatSum } from '../common/money.util';
import { ConfigService } from '@nestjs/config';
import { SettingsService } from '../settings/settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { User, UserRole } from '../user/entities/user.entity';

interface CachedToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  refreshExpiresAt?: number;
}

const TOKEN_REDIS_KEY = 'paylov:token';

@Injectable()
export class PaymentService {
  private readonly client: AxiosInstance;
  private readonly baseUrl?: string;
  private readonly logger = new Logger(PaymentService.name);

  // Paylov OAuth2 credentials (developer.paylov.uz/subscribe/authorization).
  private readonly consumerKey?: string;
  private readonly consumerSecret?: string;
  private readonly merchantUser?: string;
  private readonly merchantPass?: string;
  private readonly merchantId?: string;
  private cachedToken?: CachedToken;
  private tokenInFlight?: Promise<string>;
  private hydrationDone = false;

  // Inbound callback (Paylov→us) Basic Auth.
  private readonly callbackUsername?: string;
  private readonly callbackPassword?: string;

  constructor(
    @InjectRepository(Card)
    private readonly cardRepository: Repository<Card>,
    @InjectRepository(PaymentTransaction)
    private readonly txRepository: Repository<PaymentTransaction>,
    @InjectRepository(EscrowContract)
    private readonly contractRepo: Repository<EscrowContract>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly configService: ConfigService,
    @InjectRedis() private readonly redis: Redis,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
  ) {
    this.baseUrl = this.configService.get<string>('PAYLOV_BASE_URL');
    this.consumerKey = this.configService.get<string>('PAYLOV_CONSUMER_KEY');
    this.consumerSecret = this.configService.get<string>('PAYLOV_CONSUMER_SECRET');
    this.merchantUser = this.configService.get<string>('PAYLOV_USERNAME');
    this.merchantPass = this.configService.get<string>('PAYLOV_PASSWORD');
    this.merchantId = this.configService.get<string>('PAYLOV_MERCHANT_ID');
    this.callbackUsername = this.configService.get<string>('PAYLOV_CALLBACK_USERNAME');
    this.callbackPassword = this.configService.get<string>('PAYLOV_CALLBACK_PASSWORD');

    const missing: string[] = [];
    if (!this.baseUrl) missing.push('PAYLOV_BASE_URL');
    if (!this.consumerKey) missing.push('PAYLOV_CONSUMER_KEY');
    if (!this.consumerSecret) missing.push('PAYLOV_CONSUMER_SECRET');
    if (!this.merchantUser) missing.push('PAYLOV_USERNAME');
    if (!this.merchantPass) missing.push('PAYLOV_PASSWORD');
    if (!this.merchantId) missing.push('PAYLOV_MERCHANT_ID');
    if (missing.length) {
      this.logger.error(
        `Paylov sozlanmagan, quyidagi env'lar yo'q: ${missing.join(', ')}. ` +
          'Paylov so\'rovlari sozlanmagan deb xato qaytaradi.',
      );
    } else {
      this.logger.log('Paylov OAuth2 sozlamalari to\'liq, tayyor');
    }
    if (!this.callbackUsername || !this.callbackPassword) {
      this.logger.warn(
        'PAYLOV_CALLBACK_USERNAME/PASSWORD yo\'q. Webhook Basic Auth tekshiruvi rad etadi.',
      );
    }

    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 15_000,
      headers: { 'Content-Type': 'application/json' },
    });

    this.client.interceptors.request.use(async (config) => {
      const token = await this.getAccessToken();
      config.headers = config.headers ?? {};
      (config.headers as any)['Authorization'] = `Bearer ${token}`;
      return config;
    });

    this.client.interceptors.response.use(
      (response) => response,
      async (error) => {
        const originalRequest = error.config as any;
        if (
          error.response?.status === 401 &&
          originalRequest &&
          !originalRequest._paylovRetry
        ) {
          originalRequest._paylovRetry = true;
          this.logger.warn('Paylov 401 — kesh tozalanib, token yangilanmoqda');
          this.cachedToken = undefined;
          const fresh = await this.getAccessToken();
          originalRequest.headers = originalRequest.headers ?? {};
          originalRequest.headers['Authorization'] = `Bearer ${fresh}`;
          return this.client.request(originalRequest);
        }
        return Promise.reject(error);
      },
    );
  }

  // ─── OAuth2 ─────────────────────────────────────────────────────────────────

  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken?.accessToken && this.cachedToken.expiresAt - 60_000 > now) {
      return this.cachedToken.accessToken;
    }
    if (this.tokenInFlight) return this.tokenInFlight;

    if (
      !this.baseUrl ||
      !this.consumerKey ||
      !this.consumerSecret ||
      !this.merchantUser ||
      !this.merchantPass
    ) {
      throw new Error('Paylov OAuth2 credentials sozlanmagan');
    }

    this.tokenInFlight = this.fetchToken().finally(() => {
      this.tokenInFlight = undefined;
    });
    return this.tokenInFlight;
  }

  private async hydrateFromRedis(): Promise<void> {
    if (this.hydrationDone) return;
    this.hydrationDone = true;
    if (this.cachedToken?.refreshToken) return;

    try {
      const raw = await this.redis.get(TOKEN_REDIS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as CachedToken;
        const now = Date.now();
        const refreshAlive =
          parsed.refreshExpiresAt && parsed.refreshExpiresAt - 60_000 > now;
        if (parsed.refreshToken && refreshAlive) {
          this.cachedToken = parsed;
          this.logger.log('Paylov token Redis keshidan tiklandi');
          return;
        }
      }

      const envRefresh = this.configService.get<string>('PAYLOV_REFRESH_TOKEN');
      if (envRefresh) {
        this.cachedToken = {
          accessToken: '',
          refreshToken: envRefresh,
          expiresAt: 0,
          refreshExpiresAt: Date.now() + 6 * 24 * 3600 * 1000,
        };
        this.logger.log("PAYLOV_REFRESH_TOKEN env'dan bootstrap qilindi");
      }
    } catch (e) {
      this.logger.warn(`Paylov token Redis hydrate xatosi: ${(e as Error).message}`);
    }
  }

  private async persistToken(): Promise<void> {
    if (!this.cachedToken?.refreshToken) return;
    try {
      const ttlMs =
        (this.cachedToken.refreshExpiresAt ?? Date.now() + 7 * 24 * 3600 * 1000) -
        Date.now();
      const ttlSec = Math.max(60, Math.floor(ttlMs / 1000));
      await this.redis.set(
        TOKEN_REDIS_KEY,
        JSON.stringify(this.cachedToken),
        'EX',
        ttlSec,
      );
    } catch (e) {
      this.logger.warn(`Token Redis'ga saqlashda xato: ${(e as Error).message}`);
    }
  }

  private async fetchToken(): Promise<string> {
    await this.hydrateFromRedis();

    const basic = Buffer.from(
      `${this.consumerKey}:${this.consumerSecret}`,
    ).toString('base64');
    const url = `${this.baseUrl}/merchant/oauth2/token/`;

    const now = Date.now();
    const useRefresh =
      !!this.cachedToken?.refreshToken &&
      (!this.cachedToken.refreshExpiresAt ||
        this.cachedToken.refreshExpiresAt - 60_000 > now);

    const body = useRefresh
      ? {
          grant_type: 'refresh_token',
          refresh_token: this.cachedToken!.refreshToken,
        }
      : {
          grant_type: 'password',
          username: this.merchantUser,
          password: this.merchantPass,
        };

    try {
      const { data } = await axios.post(url, body, {
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/json',
        },
        timeout: 15_000,
      });
      if (!data?.access_token) {
        throw new Error(
          `Paylov token endpoint kutilgan javob bermadi: ${JSON.stringify(data)}`,
        );
      }
      const ttlSec = Number(data.expires_in ?? 3600);
      const refreshTtlSec = Number(data.refresh_expires_in ?? 7 * 24 * 3600);
      const issuedAt = Date.now();
      this.cachedToken = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? this.cachedToken?.refreshToken,
        expiresAt: issuedAt + ttlSec * 1000,
        refreshExpiresAt: issuedAt + refreshTtlSec * 1000,
      };
      await this.persistToken();
      this.logger.log(
        `Paylov token olindi (${useRefresh ? 'refresh' : 'password'}), access TTL=${ttlSec}s, refresh TTL=${refreshTtlSec}s`,
      );
      return data.access_token as string;
    } catch (error) {
      if (useRefresh) {
        this.logger.warn(
          'Paylov refresh_token rad etildi, password grant bilan qayta urinaman',
        );
        this.cachedToken = undefined;
        await this.redis.del(TOKEN_REDIS_KEY).catch(() => undefined);
        return this.fetchToken();
      }
      this.cachedToken = undefined;
      await this.redis.del(TOKEN_REDIS_KEY).catch(() => undefined);
      throw error;
    }
  }

  // ─── HELPERS ────────────────────────────────────────────────────────────────

  private buildExternalId(
    contractId: string | number,
    action: 'hold' | 'payout' | 'charge' | 'dismiss',
  ): string {
    return `escro_${action}_contract_${contractId}`;
  }

  private async assertCardOwnedByUser(
    userId: number,
    cardId: string,
  ): Promise<Card> {
    const card = await this.cardRepository.findOne({ where: { cardId, userId } });
    if (!card) {
      // IDOR-safe: identical 404 whether the card doesn't exist or belongs
      // to another user.
      throw new NotFoundException('Karta topilmadi');
    }
    if (!card.isActive) {
      throw new BadRequestException('Karta faol emas');
    }
    return card;
  }

  private async upsertTx(args: {
    type: TransactionType;
    contractId?: number;
    userId?: number;
    cardId?: string;
    extId?: string;
    amountTiyin: number;
  }): Promise<PaymentTransaction> {
    if (args.extId) {
      const existing = await this.txRepository.findOne({
        where: { extId: args.extId },
      });
      if (existing) return existing;
    }
    const tx = this.txRepository.create({
      type: args.type,
      contractId: args.contractId,
      userId: args.userId,
      cardId: args.cardId,
      extId: args.extId,
      amount: args.amountTiyin,
      status: TransactionStatus.PENDING,
    });
    return this.txRepository.save(tx);
  }

  private maskCardNumber(raw: string): string {
    const digits = raw.replace(/\D/g, '');
    if (digits.length < 8) return digits;
    return digits.slice(0, 6) + '*'.repeat(Math.max(0, digits.length - 10)) + digits.slice(-4);
  }

  // ─── KARTA AMALLARI ─────────────────────────────────────────────────────────

  async createCard(
    userId: number | string,
    cardNumber: string,
    expireDate: string,
    phoneNumber?: string,
  ) {
    try {
      if (!userId) {
        throw new BadRequestException('Foydalanuvchi ID-si taqdim etilmadi');
      }

      // Paylov barcha non-raqam belgilarni rad etadi — har ehtimolga
      // qarshi yana bir bor tozalaymiz va uzunlikni tekshiramiz.
      const cleanCard = cardNumber.replace(/\D/g, '');
      if (cleanCard.length < 13 || cleanCard.length > 19) {
        throw new BadRequestException(
          "Karta raqami 13–19 ta raqamdan iborat bo'lishi kerak",
        );
      }
      // Paylov docs (createUserCard): expireDate YYMM formatida bo'lishi shart.
      // Frontend "MM/YY" yoki "MMYY" yuborishi mumkin (CreateCardDto regex shu).
      const expDigits = expireDate.replace(/\D/g, '');
      if (expDigits.length !== 4) {
        throw new BadRequestException(
          "Karta muddati noto'g'ri: MM/YY yoki MMYY formatida bo'lishi kerak",
        );
      }
      const formattedExpiry = expDigits.slice(2, 4) + expDigits.slice(0, 2);

      const body: Record<string, string> = {
        serviceId: this.merchantId!,
        userId: String(userId),
        cardNumber: cleanCard,
        expireDate: formattedExpiry,
      };
      // phoneNumber Paylov uchun ixtiyoriy. Kiritilgan bo'lsa Paylov uni
      // bankdagi qayd bilan solishtiradi va mos kelmasa phone_not_match
      // qaytaradi. Bo'sh bo'lsa Paylov bankdan haqiqiy raqamni o'zi oladi
      // va o'sha raqamga SMS yuboradi.
      if (phoneNumber && phoneNumber.trim()) {
        body.phoneNumber = phoneNumber.startsWith('+')
          ? phoneNumber
          : '+' + phoneNumber.replace(/\D/g, '');
      }

      const { data } = await this.client.post(
        '/merchant/userCard/createUserCard/',
        body,
      );
      return data;
    } catch (error) {
      this.logger.error(`Paylov createCard: ${error}`);
      return handlePaymentError(error);
    }
  }

  async confirmCard(
    userId: number,
    cardId: string,
    otp: string,
    cardName?: string,
    pinfl?: string,
  ) {
    try {
      const body: Record<string, string> = { cardId, otp };
      if (cardName) body.cardName = cardName;
      if (pinfl) body.pinfl = pinfl;

      const { data } = await this.client.post(
        '/merchant/userCard/confirmUserCardCreate/',
        body,
      );

      if (data?.result?.card) {
        const c = data.result.card;
        const existing = await this.cardRepository.findOne({
          where: { cardId: c.cardId },
        });

        if (existing) {
          await this.cardRepository.update(
            { cardId: c.cardId },
            {
              balance: c.balance,
              isActive: c.status?.is_active ?? true,
              statusMessage: c.status?.status_message,
            },
          );
        } else {
          const newCard = this.cardRepository.create({
            cardId: c.cardId,
            userId,
            owner: c.owner,
            cardName: cardName || c.cardName,
            number: c.number,
            balance: c.balance,
            expireDate: c.expireDate,
            bankId: c.bankId,
            vendor: c.vendor,
            processing: c.processing,
            isActive: c.status?.is_active ?? true,
            statusMessage: c.status?.status_message,
          });
          await this.cardRepository.save(newCard);
        }
      }

      return data;
    } catch (error) {
      this.logger.error(`Paylov confirmCard: ${error}`);
      return handlePaymentError(error);
    }
  }

  async resendOtp(cardId: string) {
    try {
      const { data } = await this.client.post(
        '/merchant/userCard/resendOtp/',
        { cardId },
      );
      return data;
    } catch (error) {
      this.logger.error(`Paylov resendOtp: ${error}`);
      return handlePaymentError(error);
    }
  }

  async deleteCard(userId: number, cardId: string) {
    try {
      const card = await this.cardRepository.findOne({
        where: { cardId, userId },
      });
      if (!card) {
        return {
          result: null,
          error: { code: 'card_not_found', message: 'Karta topilmadi' },
        };
      }

      const { data } = await this.client.delete(
        '/merchant/userCard/deleteUserCard/',
        { params: { userCardId: cardId } },
      );

      if (data?.result === true) {
        await this.cardRepository.remove(card);
      }
      return data;
    } catch (error) {
      this.logger.error(`Paylov deleteCard: ${error}`);
      return handlePaymentError(error);
    }
  }

  async getMyCards(userId: number) {
    try {
      // Docs: GET /merchant/userCard/getAllUserCards/?userId=<id>
      // Paylov javobi {result: {cards: [...]}} shaklida keladi — frontend
      // aynan shu shaklni kutadi.
      const { data } = await this.client.get(
        '/merchant/userCard/getAllUserCards/',
        { params: { userId: String(userId) } },
      );
      return data;
    } catch (error) {
      this.logger.error(`Paylov getAllUserCards: ${error}`);
      return handlePaymentError(error);
    }
  }

  async getCardDetails(userId: number, cardId: string) {
    try {
      await this.assertCardOwnedByUser(userId, cardId);
      const { data } = await this.client.get(
        `/merchant/userCard/getCard/${cardId}/`,
      );
      return data;
    } catch (error) {
      this.logger.error(`Paylov getCardDetails: ${error}`);
      return handlePaymentError(error);
    }
  }

  // ─── ESCROW: HOLD / CHARGE / DISMISS / PAYOUT ───────────────────────────────

  async holdFunds(
    userId: number,
    cardId: string,
    amountSum: number,
    contractId: string | number,
  ) {
    const amountTiyin = sumToTiyin(amountSum);
    const externalId = this.buildExternalId(contractId, 'hold');
    let tx: PaymentTransaction | undefined;

    try {
      await this.assertCardOwnedByUser(userId, cardId);

      tx = await this.upsertTx({
        type: TransactionType.HOLD,
        contractId:
          typeof contractId === 'number' ? contractId : Number(contractId),
        userId,
        cardId,
        extId: externalId,
        amountTiyin,
      });

      if (tx.status === TransactionStatus.HELD && tx.paylovTransactionId) {
        return {
          result: { transactionId: tx.paylovTransactionId, alreadyHeld: true },
          error: null,
        };
      }

      const { data } = await this.client.post('/merchant/payment/hold/create/', {
        userId: String(userId),
        cardId,
        amount: amountTiyin,
        account: {},
        time: 40320,
        externalId,
        serviceId: this.merchantId,
      });

      tx.rawResponse = data;
      if (data?.result?.transactionId) {
        tx.paylovTransactionId = data.result.transactionId;
        tx.status = TransactionStatus.HELD;
      } else {
        tx.status = TransactionStatus.FAILED;
        tx.lastError = data?.error ?? data;
      }
      await this.txRepository.save(tx);

      return data;
    } catch (error) {
      // Critical: mark the tx FAILED before returning. Without this, a
      // thrown Paylov error (4xx, network 404 page, timeout) leaves the
      // tx row stuck in 'pending' forever — UI then renders it as
      // "Mablag' muzlatildi" (because the type is 'hold') misleading
      // the user into thinking the hold succeeded.
      if (tx) {
        try {
          tx.status = TransactionStatus.FAILED;
          tx.lastError = {
            message: (error as Error).message,
            response: (error as any)?.response?.data,
          };
          await this.txRepository.save(tx);
        } catch (saveErr) {
          this.logger.warn(
            `holdFunds: failed to mark tx as FAILED: ${(saveErr as Error).message}`,
          );
        }
      }
      this.logger.error(`Paylov holdFunds: ${error}`);
      return handlePaymentError(error);
    }
  }

  async fulfillEscrow(transactionId: string, amountSum: number) {
    try {
      const amountTiyin = sumToTiyin(amountSum);

      const holdTx = await this.txRepository.findOne({
        where: {
          paylovTransactionId: transactionId,
          type: TransactionType.HOLD,
        },
      });
      const chargeAuditExtId = `escro_charge_${transactionId}`;
      const chargeTx = await this.upsertTx({
        type: TransactionType.CHARGE,
        contractId: holdTx?.contractId,
        userId: holdTx?.userId,
        cardId: holdTx?.cardId,
        extId: chargeAuditExtId,
        amountTiyin,
      });

      const { data } = await this.client.post('/merchant/payment/hold/charge/', {
        transactionId,
        amount: amountTiyin,
      });

      chargeTx.rawResponse = data;
      if (data?.result) {
        chargeTx.status = TransactionStatus.CHARGED;
        if (holdTx) {
          holdTx.status = TransactionStatus.CHARGED;
          await this.txRepository.save(holdTx);
        }
      } else {
        chargeTx.status = TransactionStatus.FAILED;
        chargeTx.lastError = data?.error ?? data;
      }
      await this.txRepository.save(chargeTx);

      return data;
    } catch (error) {
      this.logger.error(`Paylov fulfillEscrow: ${error}`);
      return handlePaymentError(error);
    }
  }

  async cancelHold(transactionId: string, contractId?: string | number) {
    try {
      const holdTx = await this.txRepository.findOne({
        where: {
          paylovTransactionId: transactionId,
          type: TransactionType.HOLD,
        },
      });

      // Always store a separate DISMISS row so the timeline reads
      // "Muzlatildi → Qaytarildi" as two events. extId makes the operation
      // idempotent: a double-click reuses the same row.
      const cid = contractId ?? holdTx?.contractId;
      const externalId = cid
        ? this.buildExternalId(cid, 'dismiss')
        : `escro_dismiss_tx_${transactionId}`;
      const dismissTx = await this.upsertTx({
        type: TransactionType.DISMISS,
        contractId:
          typeof cid === 'number'
            ? cid
            : cid
              ? Number(cid)
              : holdTx?.contractId,
        userId: holdTx?.userId,
        cardId: holdTx?.cardId,
        extId: externalId,
        amountTiyin: holdTx ? Number(holdTx.amount) : 0,
      });

      // Idempotency: if Paylov already confirmed dismiss for this contract,
      // don't hit them again — return the cached result.
      if (dismissTx.status === TransactionStatus.DISMISSED) {
        return {
          result: dismissTx.rawResponse?.result ?? { status: 'cancelled' },
          error: null,
        };
      }

      const { data } = await this.client.post('/merchant/payment/hold/dismiss/', {
        transactionId,
      });

      dismissTx.rawResponse = data;
      dismissTx.paylovTransactionId = transactionId; // reference to the original hold
      if (data?.result) {
        dismissTx.status = TransactionStatus.DISMISSED;
        dismissTx.lastError = null as any;
      } else {
        dismissTx.status = TransactionStatus.FAILED;
        dismissTx.lastError = data?.error ?? data;
      }
      await this.txRepository.save(dismissTx);

      return data;
    } catch (error) {
      this.logger.error(`Paylov cancelHold: ${error}`);
      return handlePaymentError(error);
    }
  }

  async payoutToCard(
    toCardId: string,
    amountSum: number,
    contractId: string | number,
  ) {
    try {
      const amountTiyin = sumToTiyin(amountSum);
      const externalId = this.buildExternalId(contractId, 'payout');

      const card = await this.cardRepository.findOne({
        where: { cardId: toCardId },
      });
      if (!card) {
        return {
          result: null,
          error: {
            code: 'card_not_found',
            message: 'Payout karta topilmadi',
          },
        };
      }

      const tx = await this.upsertTx({
        type: TransactionType.PAYOUT,
        contractId:
          typeof contractId === 'number' ? contractId : Number(contractId),
        userId: card.userId,
        cardId: toCardId,
        extId: externalId,
        amountTiyin,
      });

      if (tx.status === TransactionStatus.PAID_OUT && tx.paylovTransactionId) {
        return {
          result: { transactionId: tx.paylovTransactionId, alreadyPaid: true },
          error: null,
        };
      }
      // Already awaiting / denied — don't push it through Paylov again.
      if (tx.status === TransactionStatus.AWAITING_APPROVAL) {
        return {
          result: null,
          error: {
            code: 'awaiting_approval',
            message: 'Payout admin tasdiqlovini kutmoqda',
          },
        };
      }
      if (tx.status === TransactionStatus.DENIED) {
        return {
          result: null,
          error: {
            code: 'denied',
            message: 'Payout admin tomonidan rad etilgan',
          },
        };
      }

      // ─── Payout protection: high-amount or KYC-gated payouts go to a
      //  manual approval queue instead of being sent straight to Paylov. ──
      const thresholdSum = this.settings.getNumber(
        'payout_auto_approve_threshold',
        5_000_000,
      );
      const requireKyc =
        this.settings.getString('payout_require_kyc', 'false').toLowerCase() ===
        'true';

      let needsApproval = amountSum > thresholdSum;
      let approvalReason = needsApproval
        ? `Summa avto-tasdiqlash chegarasidan ko'p (>${thresholdSum} so'm)`
        : '';
      if (!needsApproval && requireKyc) {
        const recipient = await this.userRepo.findOne({
          where: { id: card.userId },
        });
        if (recipient?.kycStatus !== 'approved') {
          needsApproval = true;
          approvalReason = "Qabul qiluvchining KYC tasdiqlanmagan";
        }
      }
      if (needsApproval) {
        tx.status = TransactionStatus.AWAITING_APPROVAL;
        tx.approvalNote = approvalReason;
        await this.txRepository.save(tx);
        await this.notifyAdminsOfPendingPayout(tx, approvalReason);
        this.logger.warn(
          `Payout ${tx.id} (contract ${contractId}, ${amountSum} so'm) parked for approval: ${approvalReason}`,
        );
        return {
          result: null,
          error: {
            code: 'awaiting_approval',
            message: 'Payout admin tasdiqlovini kutmoqda',
            reason: approvalReason,
          },
        };
      }

      const { data } = await this.client.post(
        '/merchant/a2c/performTransaction',
        {
          serviceId: this.merchantId,
          userId: String(card.userId),
          cardId: toCardId,
          amountInTiyin: amountTiyin,
          externalId,
        },
      );

      tx.rawResponse = data;
      const txId = data?.result?.transactionId ?? data?.transactionId;
      if (txId) {
        tx.paylovTransactionId = String(txId);
        tx.status = TransactionStatus.PAID_OUT;
      } else {
        tx.status = TransactionStatus.FAILED;
        tx.lastError = data?.error ?? data;
      }
      await this.txRepository.save(tx);

      return data;
    } catch (error) {
      this.logger.error(`Paylov payoutToCard: ${error}`);
      return handlePaymentError(error);
    }
  }

  /**
   * Approve a parked payout: sends it to Paylov and saves the result. Used
   * by the admin Payout Queue. Idempotent — calling it twice on an
   * already-paid tx returns the existing result.
   */
  async approvePayout(txId: string, adminId: number) {
    const tx = await this.txRepository.findOne({ where: { id: txId } });
    if (!tx) throw new BadRequestException('Tranzaksiya topilmadi');
    if (tx.type !== TransactionType.PAYOUT) {
      throw new BadRequestException('Faqat payout tranzaksiyalari');
    }
    if (tx.status === TransactionStatus.PAID_OUT && tx.paylovTransactionId) {
      return {
        result: { transactionId: tx.paylovTransactionId, alreadyPaid: true },
        error: null,
      };
    }
    if (tx.status !== TransactionStatus.AWAITING_APPROVAL) {
      throw new BadRequestException(
        `Tasdiqlash mumkin emas: holat=${tx.status}`,
      );
    }
    if (!tx.cardId) {
      throw new BadRequestException('Karta ID topilmadi');
    }

    try {
      const { data } = await this.client.post(
        '/merchant/a2c/performTransaction',
        {
          serviceId: this.merchantId,
          userId: String(tx.userId),
          cardId: tx.cardId,
          amountInTiyin: Number(tx.amount),
          externalId: tx.extId,
        },
      );
      tx.rawResponse = data;
      const paylovId = data?.result?.transactionId ?? data?.transactionId;
      if (paylovId) {
        tx.paylovTransactionId = String(paylovId);
        tx.status = TransactionStatus.PAID_OUT;
      } else {
        tx.status = TransactionStatus.FAILED;
        tx.lastError = data?.error ?? data;
      }
      tx.approvedBy = adminId;
      tx.approvedAt = new Date();
      await this.txRepository.save(tx);
      return data;
    } catch (error) {
      this.logger.error(`Approve payout ${txId} failed: ${error}`);
      tx.status = TransactionStatus.FAILED;
      tx.approvedBy = adminId;
      tx.approvedAt = new Date();
      await this.txRepository.save(tx);
      return handlePaymentError(error);
    }
  }

  /**
   * Deny a parked payout. Doesn't call Paylov; just records the rejection
   * and (if the contract is still in flight) flips it to DISPUTED so an
   * admin/operator can pick up the next steps with the participants.
   */
  async denyPayout(txId: string, adminId: number, reason: string) {
    const tx = await this.txRepository.findOne({ where: { id: txId } });
    if (!tx) throw new BadRequestException('Tranzaksiya topilmadi');
    if (tx.type !== TransactionType.PAYOUT) {
      throw new BadRequestException('Faqat payout tranzaksiyalari');
    }
    if (tx.status !== TransactionStatus.AWAITING_APPROVAL) {
      throw new BadRequestException(
        `Rad etish mumkin emas: holat=${tx.status}`,
      );
    }
    if (!reason || !reason.trim()) {
      throw new BadRequestException('Rad etish sababi kerak');
    }
    tx.status = TransactionStatus.DENIED;
    tx.approvedBy = adminId;
    tx.approvedAt = new Date();
    tx.approvalNote = reason.trim();
    await this.txRepository.save(tx);

    // Surface the denial to the participants by parking the contract in
    // DISPUTED so the next operator action can resolve it.
    if (tx.contractId) {
      const contract = await this.contractRepo.findOne({
        where: { id: tx.contractId },
      });
      if (contract && contract.status !== 'completed' && contract.status !== 'cancelled' && contract.status !== 'disputed') {
        contract.status = 'disputed' as any;
        contract.rejectionReason =
          contract.rejectionReason ||
          `Payout rad etildi: ${reason.trim()}`;
        await this.contractRepo.save(contract);
      }
    }
    return { ok: true, status: tx.status };
  }

  /** Notify all admins that a new payout is awaiting approval. */
  private async notifyAdminsOfPendingPayout(
    tx: PaymentTransaction,
    reason: string,
  ): Promise<void> {
    try {
      const admins = await this.userRepo.find({
        where: [{ role: UserRole.ADMIN }, { role: UserRole.SUPER_ADMIN }],
        select: ['id'],
      });
      const formatted = formatSum(tiyinToSum(tx.amount));
      for (const a of admins) {
        await this.notifications
          .create(
            a.id,
            'Payout tasdiqlovini kutmoqda',
            `Shartnoma #${tx.contractId ?? '?'} — ${formatted} so'm. Sabab: ${reason}`,
            'payout_awaits_approval',
            tx.contractId ? String(tx.contractId) : undefined,
          )
          .catch(() => undefined);
      }
    } catch (e) {
      this.logger.warn(
        `Failed to notify admins about pending payout ${tx.id}: ${(e as Error).message}`,
      );
    }
  }

  async getTransactionStatus(transactionId: string) {
    try {
      const tx = await this.txRepository.findOne({
        where: { paylovTransactionId: transactionId },
      });

      let data: any;
      if (tx?.type === TransactionType.PAYOUT) {
        // Docs: GET /merchant/a2c/checkTransaction/{TransactionId}
        // Agar tx.extId mavjud bo'lsa, byExternalId yo'lini afzal ko'ramiz.
        const res = tx?.extId
          ? await this.client.get(
              `/merchant/a2c/checkTransaction/byExternalId/${encodeURIComponent(tx.extId)}/`,
            )
          : await this.client.get(
              `/merchant/a2c/checkTransaction/${transactionId}`,
            );
        data = res.data;
      } else {
        // Docs: GET /merchant/payment/hold/status/?externalId=...
        if (!tx?.extId) {
          throw new BadRequestException(
            'Hold tranzaksiyasi uchun externalId topilmadi',
          );
        }
        const res = await this.client.get('/merchant/payment/hold/status/', {
          params: { externalId: tx.extId },
        });
        data = res.data;
      }

      if (tx) {
        tx.rawResponse = data;
        const stateRaw =
          data?.result?.status ?? data?.result?.state ?? data?.status;
        if (stateRaw) {
          const next = this.mapPaylovStateToStatus(String(stateRaw));
          if (next) tx.status = next;
        }
        await this.txRepository.save(tx);
      }

      return data;
    } catch (error) {
      this.logger.error(`Paylov getTransactionStatus: ${error}`);
      return handlePaymentError(error);
    }
  }

  // ─── WEBHOOK (Paylov → biz) ─────────────────────────────────────────────────

  verifyWebhookBasicAuth(authHeader?: string): boolean {
    if (!this.callbackUsername || !this.callbackPassword) {
      this.logger.error(
        'Webhook Basic Auth: PAYLOV_CALLBACK_USERNAME/PASSWORD sozlanmagan, callback rad etilmoqda',
      );
      return false;
    }
    if (!authHeader || !authHeader.toLowerCase().startsWith('basic ')) return false;

    const expected =
      'Basic ' +
      Buffer.from(
        `${this.callbackUsername}:${this.callbackPassword}`,
      ).toString('base64');

    try {
      const a = Buffer.from(authHeader);
      const b = Buffer.from(expected);
      return a.length === b.length && timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  async handlePaylovCallback(payload: any) {
    const id = payload?.id ?? null;
    const method: string | undefined = payload?.method;
    const params = payload?.params ?? {};

    this.logger.log(
      `Paylov callback: method=${method} id=${id} params=${JSON.stringify(params).slice(0, 300)}`,
    );

    const ok = (extra?: Record<string, any>) => ({
      jsonrpc: '2.0',
      id,
      result: { status: '0', statusText: 'OK', ...(extra ?? {}) },
    });
    const err = (status: string, statusText: string) => ({
      jsonrpc: '2.0',
      id,
      result: { status, statusText },
    });

    const findTxByPaylovId = (txId?: string | null) =>
      txId
        ? this.txRepository.findOne({
            where: { paylovTransactionId: String(txId) },
          })
        : Promise.resolve(null);

    const extractTxId = (): string | undefined =>
      params?.transaction_id ?? params?.transactionId ?? payload?.transactionId;

    try {
      switch (method) {
        case 'transaction.check': {
          const account = params?.account ?? {};
          const contractIdRaw = account?.contractId ?? account?.order_id;
          const contractId =
            contractIdRaw != null ? Number(contractIdRaw) : NaN;
          if (!Number.isFinite(contractId)) {
            return err('303', 'Order not found');
          }
          const exists = await this.txRepository.findOne({
            where: { contractId },
          });
          return exists ? ok() : err('303', 'Order not found');
        }

        case 'transaction.create': {
          const txId = extractTxId();
          const account = params?.account ?? {};
          const contractIdRaw = account?.contractId ?? account?.order_id;
          const contractId =
            contractIdRaw != null ? Number(contractIdRaw) : NaN;
          if (!txId || !Number.isFinite(contractId)) {
            return err('+1', 'transaction_id or contractId missing');
          }

          const existing = await findTxByPaylovId(txId);
          if (existing) {
            return ok({ transaction: existing.id, create_time: existing.createdAt?.getTime?.() ?? Date.now() });
          }

          const holdTx = await this.txRepository.findOne({
            where: { contractId, type: TransactionType.HOLD },
          });
          if (holdTx) {
            holdTx.paylovTransactionId = String(txId);
            holdTx.status = TransactionStatus.HELD;
            holdTx.rawResponse = payload;
            await this.txRepository.save(holdTx);
            return ok({ transaction: holdTx.id, create_time: Date.now() });
          }
          return err('303', 'Order not found');
        }

        case 'transaction.perform': {
          const txId = extractTxId();
          if (!txId) return err('+1', 'transaction_id missing');

          const tx = await findTxByPaylovId(txId);
          if (!tx) {
            this.logger.warn(`transaction.perform unknown tx ${txId}`);
            return err('-31003', 'Transaction not found');
          }
          tx.rawResponse = payload;
          tx.status = TransactionStatus.CHARGED;
          await this.txRepository.save(tx);
          return ok({ transaction: tx.id, perform_time: Date.now() });
        }

        case 'transaction.cancel': {
          const txId = extractTxId();
          if (!txId) return err('+1', 'transaction_id missing');

          const tx = await findTxByPaylovId(txId);
          if (!tx) return err('-31003', 'Transaction not found');
          tx.rawResponse = payload;
          tx.status = TransactionStatus.DISMISSED;
          await this.txRepository.save(tx);
          return ok({ transaction: tx.id, cancel_time: Date.now(), state: -1 });
        }

        case 'transaction.status': {
          const txId = extractTxId();
          if (!txId) return err('+1', 'transaction_id missing');
          const tx = await findTxByPaylovId(txId);
          if (!tx) return err('-31003', 'Transaction not found');
          return ok({
            transaction: tx.id,
            state: tx.status,
            type: tx.type,
            amount: tx.amount,
          });
        }

        default: {
          // Documented JSON-RPC method'larga tushmagan callback'larni
          // ko'r-ko'rona qabul qilamiz va status update'iga harakat qilamiz.
          const txId = extractTxId();
          const tx = await findTxByPaylovId(txId);
          if (tx) {
            tx.rawResponse = payload;
            const stateRaw =
              params?.state ??
              params?.status ??
              payload?.state ??
              payload?.status;
            if (params?.cancelled === true) {
              tx.status = TransactionStatus.DISMISSED;
            } else if (stateRaw) {
              const mapped = this.mapPaylovStateToStatus(String(stateRaw));
              if (mapped) tx.status = mapped;
            }
            await this.txRepository.save(tx);
          } else {
            this.logger.warn(
              `Paylov callback: noma'lum method/tx (method=${method} txId=${txId})`,
            );
          }
          return ok();
        }
      }
    } catch (e) {
      this.logger.error(`Callback handler error: ${e}`);
      return err('-31099', 'Internal error');
    }
  }

  private mapPaylovStateToStatus(state: string): TransactionStatus | null {
    const s = String(state).toLowerCase();
    if (s === '0' || s === 'ok' || s === 'paid' || s === 'success') {
      return TransactionStatus.CHARGED;
    }
    if (s.includes('held') || s === '1' || s === 'hold' || s === 'created') {
      return TransactionStatus.HELD;
    }
    if (s.includes('charge') || s === '2' || s === 'completed') {
      return TransactionStatus.CHARGED;
    }
    if (s.includes('dismiss') || s === '-1' || s === 'cancelled') {
      return TransactionStatus.DISMISSED;
    }
    if (s.includes('payout') || s === 'paid_out') {
      return TransactionStatus.PAID_OUT;
    }
    if (s.includes('fail') || s.includes('error')) {
      return TransactionStatus.FAILED;
    }
    return null;
  }

  // ─── ADMIN / RECONCILIATION ─────────────────────────────────────────────────

  async getTransactionsByContract(
    contractId: number,
    user?: { userId?: number; phoneNumber?: string; role?: string },
  ) {
    if (user) {
      const isAdmin = user.role === 'admin' || user.role === 'super_admin';
      if (!isAdmin) {
        const contract = await this.contractRepo.findOne({
          where: { id: contractId },
        });
        if (!contract) {
          throw new BadRequestException('Shartnoma topilmadi');
        }
        const phoneDigits = (s?: string) => String(s ?? '').replace(/\D/g, '');
        const owns =
          contract.creatorId === user.userId ||
          contract.executorId === user.userId ||
          phoneDigits(contract.executorPhoneNumber) === phoneDigits(user.phoneNumber);
        if (!owns) {
          // IDOR-safe: opaque 404 to a non-participant.
          throw new NotFoundException('Shartnoma topilmadi');
        }
      }
    }
    return this.txRepository.find({
      where: { contractId },
      order: { createdAt: 'ASC' },
    });
  }

  /**
   * Per-contract financial audit. Walks the contract's payment_transactions
   * and verifies the invariants in `auditContract` (held >= charged + dismissed,
   * paidOut <= charged, paidOut == amount, held == amount + commission).
   * Used for both the admin Reconciliation page and as a sanity check
   * before settlement.
   */
  async auditOneContract(contractId: number) {
    const contract = await this.contractRepo.findOne({ where: { id: contractId } });
    if (!contract) {
      throw new BadRequestException('Shartnoma topilmadi');
    }
    const transactions = await this.txRepository.find({
      where: { contractId },
      order: { createdAt: 'ASC' },
    });
    return auditContract({
      contractId: contract.id,
      expectedAmountSum: Number(contract.amount ?? 0),
      expectedCommissionSum: Number(contract.commissionAmount ?? 0),
      transactions,
    });
  }

  /**
   * Full reconciliation sweep across every contract. One pass over the
   * contracts table + one pass over the transactions table; results are
   * grouped in JS. Returns flagged contracts (those failing any
   * invariant) plus aggregate totals so the admin can see the size of
   * the discrepancy at a glance.
   *
   * For tens of thousands of contracts we'd paginate; current scale is
   * comfortably small.
   */
  async runReconciliation() {
    const [contracts, allTxs] = await Promise.all([
      this.contractRepo.find({
        select: ['id', 'title', 'status', 'amount', 'commissionAmount'],
      }),
      this.txRepository.find(),
    ]);
    const txsByContract = new Map<number, PaymentTransaction[]>();
    for (const tx of allTxs) {
      if (tx.contractId == null) continue;
      const arr = txsByContract.get(tx.contractId) ?? [];
      arr.push(tx);
      txsByContract.set(tx.contractId, arr);
    }
    const results = contracts.map((c) => {
      const audit = auditContract({
        contractId: c.id,
        expectedAmountSum: Number(c.amount ?? 0),
        expectedCommissionSum: Number(c.commissionAmount ?? 0),
        transactions: txsByContract.get(c.id) ?? [],
      });
      return {
        ...audit,
        title: c.title,
        status: c.status,
        amount: Number(c.amount ?? 0),
        commissionAmount: Number(c.commissionAmount ?? 0),
      };
    });
    const flagged = results.filter((r) => !r.ok);
    const totalsTiyin = results.reduce(
      (acc, r) => {
        acc.held += r.sums.held;
        acc.charged += r.sums.charged;
        acc.dismissed += r.sums.dismissed;
        acc.paidOut += r.sums.paidOut;
        return acc;
      },
      { held: 0, charged: 0, dismissed: 0, paidOut: 0 },
    );
    return {
      totalContracts: contracts.length,
      flaggedCount: flagged.length,
      okCount: contracts.length - flagged.length,
      totalsTiyin,
      flagged,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Admin payout queue: payout-type transactions in non-final states
   * (`pending`, `failed`). Returns each transaction joined with its parent
   * contract so the admin can decide whether to retry or escalate.
   */
  async getPayoutQueue() {
    const txs = await this.txRepository
      .createQueryBuilder('t')
      .where('t.type = :type', { type: 'payout' })
      .andWhere('t.status IN (:...statuses)', {
        statuses: ['pending', 'failed', 'awaiting_approval'],
      })
      .orderBy('t.createdAt', 'ASC')
      .getMany();
    if (txs.length === 0) return [];

    const contractIds = Array.from(
      new Set(txs.map((t) => t.contractId).filter((x) => x != null)),
    ) as number[];
    const contracts = contractIds.length
      ? await this.contractRepo.find({
          where: contractIds.map((id) => ({ id })),
        })
      : [];
    const byId = new Map(contracts.map((c) => [c.id, c]));
    return txs.map((t) => ({
      ...t,
      contract: t.contractId
        ? byId.get(t.contractId)
          ? {
              id: byId.get(t.contractId)!.id,
              title: byId.get(t.contractId)!.title,
              amount: byId.get(t.contractId)!.amount,
              status: byId.get(t.contractId)!.status,
              receiverCardId: byId.get(t.contractId)!.receiverCardId,
              transactionId: byId.get(t.contractId)!.transactionId,
            }
          : null
        : null,
    }));
  }

  /** Build a CSV of payment transactions in the given window. Admin-only. */
  async exportTransactionsCsv(filters: {
    from?: string;
    to?: string;
    type?: string;
    status?: string;
  }): Promise<string> {
    const qb = this.txRepository
      .createQueryBuilder('t')
      .orderBy('t.createdAt', 'DESC');
    if (filters.from) qb.andWhere('t."createdAt" >= :from', { from: filters.from });
    if (filters.to) qb.andWhere('t."createdAt" <= :to', { to: filters.to });
    if (filters.type) qb.andWhere('t.type = :type', { type: filters.type });
    if (filters.status) qb.andWhere('t.status = :status', { status: filters.status });
    const rows = await qb.getMany();

    const headers = [
      'id',
      'contract_id',
      'type',
      'status',
      'amount',
      'paylov_tx_id',
      'ext_id',
      'card_id',
      'user_id',
      'created_at',
      'updated_at',
      'last_error',
    ];
    const data = rows.map((t) => [
      t.id,
      t.contractId ?? '',
      t.type,
      t.status,
      Number(t.amount),
      t.paylovTransactionId ?? '',
      t.extId ?? '',
      t.cardId ?? '',
      t.userId ?? '',
      t.createdAt,
      t.updatedAt,
      t.lastError ? JSON.stringify(t.lastError) : '',
    ]);
    return buildCsv(headers, data);
  }
}
