import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { timingSafeEqual, randomUUID } from 'crypto';
import axios, { AxiosInstance } from 'axios';
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
}

@Injectable()
export class PaymentService {
  private readonly client: AxiosInstance;
  private readonly baseUrl?: string;
  private readonly logger = new Logger(PaymentService.name);

  // Mock mode for pitch demo: skips Paylov calls, returns canned successful
  // responses, and writes audit rows to the DB so the rest of the system
  // (admin views, contract status transitions) behaves as if Paylov said yes.
  private readonly mockMode: boolean;

  // Paylov OAuth2 credentials (developer.paylov.uz/subscribe/authorization).
  private readonly consumerKey?: string;
  private readonly consumerSecret?: string;
  private readonly merchantUser?: string;
  private readonly merchantPass?: string;
  private cachedToken?: CachedToken;
  private tokenInFlight?: Promise<string>;

  // Inbound callback (Paylov→us) Basic Auth.
  private readonly callbackUsername?: string;
  private readonly callbackPassword?: string;

  constructor(
    @InjectRepository(Card)
    private readonly cardRepository: Repository<Card>,
    @InjectRepository(PaymentTransaction)
    private readonly txRepository: Repository<PaymentTransaction>,
    private readonly configService: ConfigService,
  ) {
    this.baseUrl = this.configService.get<string>('PAYLOV_BASE_URL');
    this.consumerKey = this.configService.get<string>('PAYLOV_CONSUMER_KEY');
    this.consumerSecret = this.configService.get<string>('PAYLOV_CONSUMER_SECRET');
    this.merchantUser = this.configService.get<string>('PAYLOV_USERNAME');
    this.merchantPass = this.configService.get<string>('PAYLOV_PASSWORD');
    this.callbackUsername = this.configService.get<string>('PAYLOV_CALLBACK_USERNAME');
    this.callbackPassword = this.configService.get<string>('PAYLOV_CALLBACK_PASSWORD');
    this.mockMode = this.configService.get<string>('PAYLOV_MODE') === 'mock';

    if (this.mockMode) {
      this.logger.warn(
        'PAYLOV_MODE=mock — Paylov chaqiruvlari soxta-muvaffaqiyat qaytaradi (demo).',
      );
    } else {
      if (!this.baseUrl) {
        this.logger.warn('PAYLOV_BASE_URL yo\'q.');
      }
      if (
        !this.consumerKey ||
        !this.consumerSecret ||
        !this.merchantUser ||
        !this.merchantPass
      ) {
        this.logger.warn(
          'PAYLOV_CONSUMER_KEY/SECRET/USERNAME/PASSWORD yo\'q. Paylov so\'rovlari ishlamaydi.',
        );
      }
    }

    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 15_000,
      headers: { 'Content-Type': 'application/json' },
    });

    if (!this.mockMode) {
      this.client.interceptors.request.use(async (config) => {
        const token = await this.getAccessToken();
        config.headers = config.headers ?? {};
        (config.headers as any)['Authorization'] = `Bearer ${token}`;
        return config;
      });
    }
  }

  // ─── OAuth2 ─────────────────────────────────────────────────────────────────

  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAt - 60_000 > now) {
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

    const basic = Buffer.from(
      `${this.consumerKey}:${this.consumerSecret}`,
    ).toString('base64');
    const url = `${this.baseUrl}/merchant/oauth2/token/`;

    this.tokenInFlight = (async () => {
      try {
        const { data } = await axios.post(
          url,
          {
            grant_type: 'password',
            username: this.merchantUser,
            password: this.merchantPass,
          },
          {
            headers: {
              Authorization: `Basic ${basic}`,
              'Content-Type': 'application/json',
            },
            timeout: 15_000,
          },
        );
        if (!data?.access_token) {
          throw new Error(
            `Paylov token endpoint kutilgan javob bermadi: ${JSON.stringify(data)}`,
          );
        }
        const ttlSec = Number(data.expires_in ?? 3600);
        this.cachedToken = {
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
          expiresAt: Date.now() + ttlSec * 1000,
        };
        return data.access_token as string;
      } finally {
        this.tokenInFlight = undefined;
      }
    })();

    return this.tokenInFlight;
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
    phoneNumber: string,
  ) {
    try {
      if (!userId) {
        throw new BadRequestException('Foydalanuvchi ID-si taqdim etilmadi');
      }

      const cleanCard = cardNumber.replace(/\s+/g, '');
      const parts = expireDate.split('/');
      const formattedExpiry =
        parts.length === 2
          ? parts[1].trim() + parts[0].trim()
          : expireDate.replace(/\//g, '');
      const cleanPhone = phoneNumber.startsWith('+')
        ? phoneNumber
        : '+' + phoneNumber.replace(/\D/g, '');

      if (this.mockMode) {
        const cid = `mock_${randomUUID()}`;
        this.logger.log(`[MOCK] createCard userId=${userId} cid=${cid}`);
        return {
          result: {
            cid,
            otpSentPhone: cleanPhone.slice(0, 4) + '****' + cleanPhone.slice(-4),
            // Demo uchun hint — frontend ham, support ham bilishi uchun:
            mock: true,
            mockHint: 'OTP sifatida har qanday 4-8 raqamni kiriting',
            // confirmCard uchun kerakli ma'lumotlar:
            mockCard: {
              cardId: cid,
              userId: Number(userId),
              cardNumber: cleanCard,
              expireDate: formattedExpiry,
              phoneNumber: cleanPhone,
            },
          },
          error: null,
        };
      }

      const { data } = await this.client.post(
        '/merchant/userCard/createUserCard/',
        {
          userId: String(userId),
          cardNumber: cleanCard,
          expireDate: formattedExpiry,
          phoneNumber: cleanPhone,
        },
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
    _pinfl?: string,
  ) {
    try {
      if (this.mockMode) {
        // Demo: har qanday OTP qabul, fake card DB'ga saqlanadi.
        const existing = await this.cardRepository.findOne({ where: { cardId } });
        let card = existing;
        if (!card) {
          card = this.cardRepository.create({
            cardId,
            userId,
            owner: 'MOCK CARDHOLDER',
            cardName: cardName || 'Demo karta',
            number: this.maskCardNumber('9860' + Date.now().toString().slice(-12)),
            balance: 100_000_000, // 1 mln so'm tiyin'da
            expireDate: '2812',
            bankId: 'mock-bank',
            vendor: 'UZCARD',
            processing: 'MOCK',
            isActive: true,
            statusMessage: 'Mock active card',
          });
          await this.cardRepository.save(card);
        }
        this.logger.log(`[MOCK] confirmCard userId=${userId} cardId=${cardId}`);
        return {
          result: {
            card: {
              cardId: card.cardId,
              userId: card.userId,
              owner: card.owner,
              cardName: card.cardName,
              number: card.number,
              balance: card.balance,
              expireDate: card.expireDate,
              bankId: card.bankId,
              vendor: card.vendor,
              processing: card.processing,
              status: { is_active: true, status_message: card.statusMessage },
            },
            mock: true,
          },
          error: null,
        };
      }

      const { data } = await this.client.post(
        '/merchant/userCard/confirmUserCardCreate/',
        { cardId, otp },
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
    if (this.mockMode) {
      this.logger.log(`[MOCK] resendOtp cardId=${cardId}`);
      return { result: { sent: true, mock: true }, error: null };
    }
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

      if (this.mockMode) {
        await this.cardRepository.remove(card);
        this.logger.log(`[MOCK] deleteCard userId=${userId} cardId=${cardId}`);
        return { result: true, mock: true };
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
      return await this.cardRepository.find({
        where: { userId },
        order: { createdAt: 'DESC' },
      });
    } catch (error) {
      this.logger.error(`getMyCards: ${error}`);
      return [];
    }
  }

  async getCardDetails(userId: number, cardId: string) {
    try {
      const card = await this.assertCardOwnedByUser(userId, cardId);
      if (this.mockMode) {
        return {
          result: {
            card: {
              cardId: card.cardId,
              owner: card.owner,
              number: card.number,
              balance: card.balance,
              expireDate: card.expireDate,
              vendor: card.vendor,
              status: { is_active: card.isActive, status_message: card.statusMessage },
            },
            mock: true,
          },
          error: null,
        };
      }
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

      if (this.mockMode) {
        const fakeId = randomUUID();
        tx.paylovTransactionId = fakeId;
        tx.status = TransactionStatus.HELD;
        tx.rawResponse = { mock: true, transactionId: fakeId };
        await this.txRepository.save(tx);
        this.logger.log(`[MOCK] holdFunds contract=${contractId} amount=${amountSum} tx=${fakeId}`);
        return { result: { transactionId: fakeId, mock: true }, error: null };
      }

      const { data } = await this.client.post('/payment/hold/create/', {
        userId: String(userId),
        cardId,
        amount: amountTiyin,
        time: 40320,
        externalId,
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

      if (this.mockMode) {
        chargeTx.status = TransactionStatus.CHARGED;
        chargeTx.rawResponse = { mock: true, transactionId, charged: true };
        if (holdTx) {
          holdTx.status = TransactionStatus.CHARGED;
          await this.txRepository.save(holdTx);
        }
        await this.txRepository.save(chargeTx);
        this.logger.log(`[MOCK] fulfillEscrow tx=${transactionId} amount=${amountSum}`);
        return {
          result: {
            transactionId,
            payedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
            mock: true,
          },
          error: null,
        };
      }

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

      if (this.mockMode) {
        if (tx) {
          tx.status = TransactionStatus.DISMISSED;
          tx.rawResponse = { mock: true, transactionId, status: 'cancelled' };
          await this.txRepository.save(tx);
        }
        this.logger.log(`[MOCK] cancelHold tx=${transactionId}`);
        return {
          result: { transactionId, status: 'cancelled', mock: true },
          error: null,
        };
      }

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

      if (this.mockMode) {
        const fakeId = randomUUID();
        tx.paylovTransactionId = fakeId;
        tx.status = TransactionStatus.PAID_OUT;
        tx.rawResponse = { mock: true, transactionId: fakeId };
        await this.txRepository.save(tx);
        this.logger.log(`[MOCK] payoutToCard contract=${contractId} amount=${amountSum} tx=${fakeId}`);
        return {
          result: {
            transactionId: fakeId,
            status: 'success',
            statusText: 'OK',
            mock: true,
          },
          error: null,
        };
      }

      const { data } = await this.client.post(
        '/merchant/a2c/performTransaction',
        {
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

      if (this.mockMode) {
        if (!tx) {
          return {
            result: null,
            error: { code: 'tx_not_found', message: 'Tranzaksiya topilmadi' },
          };
        }
        return {
          result: {
            transactionId,
            status: tx.status,
            type: tx.type,
            amount: tx.amount,
            mock: true,
          },
          error: null,
        };
      }

      let data: any;
      if (tx?.type === TransactionType.PAYOUT) {
        const res = await this.client.get(
          `/merchant/a2c/checkTransaction/${transactionId}`,
        );
        data = res.data;
      } else {
        const res = await this.client.get(
          '/merchant/payment/hold/status/',
          { params: { transactionId } },
        );
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
      this.logger.warn(
        'PAYLOV_CALLBACK_USERNAME/PASSWORD sozlanmagan, Basic Auth tekshiruvi o\'tkazib yuborildi',
      );
      return true;
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

    try {
      if (method === 'transaction.check') {
        const account = params?.account ?? {};
        const contractIdRaw = account?.contractId ?? account?.order_id;
        const contractId = contractIdRaw != null ? Number(contractIdRaw) : NaN;
        if (!Number.isFinite(contractId)) {
          return err('303', 'Order not found');
        }
        const exists = await this.txRepository.findOne({
          where: { contractId },
        });
        return exists ? ok() : err('303', 'Order not found');
      }

      if (method === 'transaction.perform') {
        const txId: string | undefined =
          params?.transaction_id ?? params?.transactionId;
        if (!txId) return err('+1', 'transaction_id missing');

        const tx = await this.txRepository.findOne({
          where: { paylovTransactionId: txId },
        });
        if (!tx) {
          this.logger.warn(`transaction.perform unknown tx ${txId}`);
          return ok();
        }
        tx.rawResponse = payload;
        tx.status = TransactionStatus.CHARGED;
        await this.txRepository.save(tx);
        return ok();
      }

      const txId =
        params?.transaction_id ??
        params?.transactionId ??
        payload?.transactionId;
      if (txId) {
        const tx = await this.txRepository.findOne({
          where: { paylovTransactionId: String(txId) },
        });
        if (tx) {
          tx.rawResponse = payload;
          const stateRaw =
            params?.state ?? params?.status ?? payload?.state ?? payload?.status;
          if (params?.cancelled === true) {
            tx.status = TransactionStatus.DISMISSED;
          } else if (stateRaw) {
            const mapped = this.mapPaylovStateToStatus(String(stateRaw));
            if (mapped) tx.status = mapped;
          }
          await this.txRepository.save(tx);
        }
      }

      return ok();
    } catch (e) {
      this.logger.error(`Callback handler error: ${e}`);
      return err('+1', 'Internal error');
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
