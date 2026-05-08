import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
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
import { handlePaymentError } from './utils/payment-error.handler';
import { ConfigService } from '@nestjs/config';

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
    private readonly configService: ConfigService,
    @InjectRedis() private readonly redis: Redis,
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

  private toTiyin(amountSum: number): number {
    if (!Number.isFinite(amountSum) || amountSum < 0) {
      throw new BadRequestException('Noto\'g\'ri summa');
    }
    return Math.round(amountSum * 100);
  }

  private buildExternalId(
    contractId: string | number,
    action: 'hold' | 'payout' | 'charge',
  ): string {
    return `escro_${action}_contract_${contractId}`;
  }

  private async assertCardOwnedByUser(
    userId: number,
    cardId: string,
  ): Promise<Card> {
    const card = await this.cardRepository.findOne({ where: { cardId, userId } });
    if (!card) {
      throw new ForbiddenException('Karta sizga tegishli emas yoki topilmadi');
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
      const cards = await this.cardRepository.find({
        where: { userId },
        order: { createdAt: 'DESC' },
      });
      // Frontend Paylov javob shakli ({result: {cards}, error}) ni kutadi —
      // shu sababli lokal DB javobini ham xuddi shunday o'rab qaytaramiz.
      return { result: { cards }, error: null };
    } catch (error) {
      this.logger.error(`getMyCards: ${error}`);
      return {
        result: { cards: [] },
        error: { code: 'internal_error', message: (error as Error).message },
      };
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
    try {
      await this.assertCardOwnedByUser(userId, cardId);

      const amountTiyin = this.toTiyin(amountSum);
      const externalId = this.buildExternalId(contractId, 'hold');

      const tx = await this.upsertTx({
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

      const { data } = await this.client.post('/payment/hold/create/', {
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
      this.logger.error(`Paylov holdFunds: ${error}`);
      return handlePaymentError(error);
    }
  }

  async fulfillEscrow(transactionId: string, amountSum: number) {
    try {
      const amountTiyin = this.toTiyin(amountSum);

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

      const { data } = await this.client.post('/payment/hold/charge/', {
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

  async cancelHold(transactionId: string) {
    try {
      const tx = await this.txRepository.findOne({
        where: {
          paylovTransactionId: transactionId,
          type: TransactionType.HOLD,
        },
      });

      const { data } = await this.client.post('/payment/hold/dismiss/', {
        transactionId,
      });

      if (tx) {
        tx.status = data?.result
          ? TransactionStatus.DISMISSED
          : TransactionStatus.FAILED;
        tx.rawResponse = data;
        if (!data?.result) tx.lastError = data?.error ?? data;
        await this.txRepository.save(tx);
      }

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
      const amountTiyin = this.toTiyin(amountSum);
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

  async getTransactionsByContract(contractId: number) {
    return this.txRepository.find({
      where: { contractId },
      order: { createdAt: 'DESC' },
    });
  }
}
