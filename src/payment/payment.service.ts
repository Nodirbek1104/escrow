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
import { Card } from './entities/payment.entity';
import {
  PaymentTransaction,
  TransactionStatus,
  TransactionType,
} from './entities/transaction.entity';
import { handlePaymentError } from './utils/payment-error.handler';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class PaymentService {
  private readonly client: AxiosInstance;
  private readonly logger = new Logger(PaymentService.name);
  private readonly callbackUsername?: string;
  private readonly callbackPassword?: string;

  constructor(
    @InjectRepository(Card)
    private readonly cardRepository: Repository<Card>,
    @InjectRepository(PaymentTransaction)
    private readonly txRepository: Repository<PaymentTransaction>,
    private readonly configService: ConfigService,
  ) {
    const baseUrl = this.configService.get<string>('PAYLOV_BASE_URL');
    const token = this.configService.get<string>('PAYLOV_TOKEN');
    const merchantId = this.configService.get<string>('PAYLOV_MERCHANT_ID');
    this.callbackUsername = this.configService.get<string>('PAYLOV_CALLBACK_USERNAME');
    this.callbackPassword = this.configService.get<string>('PAYLOV_CALLBACK_PASSWORD');

    if (!baseUrl || !token || !merchantId) {
      this.logger.warn(
        'PAYLOV_BASE_URL / PAYLOV_TOKEN / PAYLOV_MERCHANT_ID env yo\'q. To\'lov so\'rovlari ishlamaydi.',
      );
    }

    this.client = axios.create({
      baseURL: baseUrl,
      timeout: 15_000,
      headers: {
        Authorization: `Bearer ${token}`,
        'Merchant-Id': merchantId ?? '',
        'Content-Type': 'application/json',
      },
    });
  }

  // ─── HELPERS ────────────────────────────────────────────────────────────────

  /**
   * Paylov so'm emas, tiyin (1 so'm = 100 tiyin) kutadi. Float xatolaridan
   * qochish uchun stringga o'girib, * 100 qilamiz.
   */
  private toTiyin(sumOrAlready: number, alreadyTiyin = false): number {
    if (alreadyTiyin) return Math.round(sumOrAlready);
    if (!Number.isFinite(sumOrAlready) || sumOrAlready < 0) {
      throw new BadRequestException('Noto\'g\'ri summa');
    }
    // 100 ga ko'paytirib, butun raqamga keltiramiz
    return Math.round(sumOrAlready * 100);
  }

  /**
   * Bir xil shartnoma + harakat uchun bir xil extId. Retry'da yangi tranzaksiya
   * yaratilmasligi uchun deterministik kalit.
   */
  private buildExtId(contractId: string | number, action: 'hold' | 'payout'): string {
    return `escro_${action}_contract_${contractId}`;
  }

  /** Karta foydalanuvchiga tegishli ekanini tekshiradi. */
  private async assertCardOwnedByUser(userId: number, cardId: string): Promise<Card> {
    const card = await this.cardRepository.findOne({ where: { cardId, userId } });
    if (!card) {
      throw new ForbiddenException('Karta sizga tegishli emas yoki topilmadi');
    }
    if (!card.isActive) {
      throw new BadRequestException('Karta faol emas');
    }
    return card;
  }

  /** Audit yozuvini yaratadi yoki extId bo'yicha mavjudini topadi. */
  private async upsertTx(args: {
    type: TransactionType;
    contractId?: number;
    userId?: number;
    cardId?: string;
    extId?: string;
    amountTiyin: number;
  }): Promise<PaymentTransaction> {
    if (args.extId) {
      const existing = await this.txRepository.findOne({ where: { extId: args.extId } });
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

  // ─── KARTA AMALLARI ─────────────────────────────────────────────────────────

  /** Karta ulashni boshlash (Paylov OTP yuboradi). */
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
      // MM/YY → YYMM
      const parts = expireDate.split('/');
      const formattedExpiry =
        parts.length === 2
          ? parts[1].trim() + parts[0].trim()
          : expireDate.replace(/\//g, '');

      const cleanPhone = phoneNumber.startsWith('+')
        ? phoneNumber
        : '+' + phoneNumber.replace(/\D/g, '');

      const { data } = await this.client.post('/merchant/userCard/createUserCard/', {
        userId: String(userId),
        cardNumber: cleanCard,
        expireDate: formattedExpiry,
        phoneNumber: cleanPhone,
      });

      return data;
    } catch (error) {
      this.logger.error(`Paylov createCard: ${error}`);
      return handlePaymentError(error);
    }
  }

  /** OTP orqali karta ulashni tasdiqlash. */
  async confirmCard(
    userId: number,
    cardId: string,
    otp: string,
    cardName?: string,
    _pinfl?: string,
  ) {
    try {
      const { data } = await this.client.post(
        '/merchant/userCard/confirmUserCardCreate/',
        { cardId, otp },
      );

      if (data?.result?.card) {
        const c = data.result.card;
        const existing = await this.cardRepository.findOne({ where: { cardId: c.cardId } });

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

  /**
   * OTP qayta yuborish. Paylov hujjatida aniq path nomi: `resendOtp` yoki
   * `resendUserCardOtp`. TODO: aniq endpoint nomini tekshirish kerak.
   */
  async resendOtp(cardId: string) {
    try {
      // TODO: verify against developer.paylov.uz docs
      const { data } = await this.client.post('/merchant/userCard/resendOtp/', {
        cardId,
      });
      return data;
    } catch (error) {
      this.logger.error(`Paylov resendOtp: ${error}`);
      return handlePaymentError(error);
    }
  }

  async deleteCard(userId: number, cardId: string) {
    try {
      const card = await this.cardRepository.findOne({ where: { cardId, userId } });
      if (!card) {
        return { result: null, error: { code: 'card_not_found', message: 'Karta topilmadi' } };
      }

      const { data } = await this.client.delete('/merchant/userCard/deleteUserCard/', {
        params: { userCardId: cardId },
      });

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
      await this.assertCardOwnedByUser(userId, cardId);
      const { data } = await this.client.get(`/merchant/userCard/getCard/${cardId}/`);
      return data;
    } catch (error) {
      this.logger.error(`Paylov getCardDetails: ${error}`);
      return handlePaymentError(error);
    }
  }

  // ─── ESCROW: HOLD / CHARGE / DISMISS / PAYOUT ───────────────────────────────

  /**
   * Xaridor kartasidagi mablag'ni 28 kungacha muzlatadi.
   * Idempotent: bir xil contractId uchun bir xil extId yuboriladi.
   */
  async holdFunds(
    userId: number,
    cardId: string,
    amountSum: number,
    contractId: string | number,
  ) {
    try {
      await this.assertCardOwnedByUser(userId, cardId);

      const amountTiyin = this.toTiyin(amountSum);
      const extId = this.buildExtId(contractId, 'hold');

      const tx = await this.upsertTx({
        type: TransactionType.HOLD,
        contractId: typeof contractId === 'number' ? contractId : Number(contractId),
        userId,
        cardId,
        extId,
        amountTiyin,
      });

      // Agar oldindan muvaffaqiyatli muzlatilgan bo'lsa, qaytaramiz
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
        time: 40320, // 28 kun (daqiqada)
        description: `Escrow Contract #${contractId}`,
        extId,
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

  /**
   * Muzlatilgan pulni merchant hisobiga o'tkazish (Paylov tilida "charge").
   * E'tibor: bu yerda pul ijrochiga emas, merchant hisobiga tushadi.
   * Ijrochiga o'tkazish uchun keyin `payoutToCard` chaqirilishi kerak.
   */
  async fulfillEscrow(transactionId: string, amountSum: number) {
    try {
      const amountTiyin = this.toTiyin(amountSum);

      // Audit: charge harakatini yozamiz
      let tx = await this.txRepository.findOne({
        where: { paylovTransactionId: transactionId, type: TransactionType.HOLD },
      });
      const chargeAuditExtId = `escro_charge_${transactionId}`;
      const chargeTx = await this.upsertTx({
        type: TransactionType.CHARGE,
        contractId: tx?.contractId,
        userId: tx?.userId,
        cardId: tx?.cardId,
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
        if (tx) {
          tx.status = TransactionStatus.CHARGED;
          await this.txRepository.save(tx);
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

  /** Muzlatishni bekor qilish (xaridorga pul qaytariladi). */
  async cancelHold(transactionId: string) {
    try {
      const tx = await this.txRepository.findOne({
        where: { paylovTransactionId: transactionId, type: TransactionType.HOLD },
      });

      const { data } = await this.client.post('/payment/hold/dismiss/', { transactionId });

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

  /**
   * Merchant hisobidan ijrochi (sotuvchi) kartasiga o'tkazma (P2P payout).
   * TODO: Paylov hujjatida aniq endpoint nomini tasdiqlash. Quyidagi yo'l
   * konvensiya bo'yicha taxmin qilingan.
   */
  async payoutToCard(toCardId: string, amountSum: number, contractId: string | number) {
    try {
      const amountTiyin = this.toTiyin(amountSum);
      const extId = this.buildExtId(contractId, 'payout');

      const tx = await this.upsertTx({
        type: TransactionType.PAYOUT,
        contractId: typeof contractId === 'number' ? contractId : Number(contractId),
        cardId: toCardId,
        extId,
        amountTiyin,
      });

      if (tx.status === TransactionStatus.PAID_OUT && tx.paylovTransactionId) {
        return {
          result: { transactionId: tx.paylovTransactionId, alreadyPaid: true },
          error: null,
        };
      }

      // TODO: verify against developer.paylov.uz docs — endpoint may be
      // `/payment/payout/create/` or `/merchant/payout/create/` depending on tier.
      const { data } = await this.client.post('/payment/payout/create/', {
        toCardId,
        amount: amountTiyin,
        extId,
        description: `Escrow payout for Contract #${contractId}`,
      });

      tx.rawResponse = data;
      if (data?.result?.transactionId) {
        tx.paylovTransactionId = data.result.transactionId;
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

  /** Reconciliation: Paylov'dagi tranzaksiyaning hozirgi holatini so'raydi. */
  async getTransactionStatus(transactionId: string) {
    try {
      // TODO: verify path — could be `/payment/hold/{id}/` or `/payment/transaction/{id}/`
      const { data } = await this.client.get(`/payment/transaction/${transactionId}/`);

      const tx = await this.txRepository.findOne({
        where: { paylovTransactionId: transactionId },
      });
      if (tx && data?.result?.state) {
        tx.rawResponse = data;
        const next = this.mapPaylovStateToStatus(data.result.state);
        if (next) tx.status = next;
        await this.txRepository.save(tx);
      }

      return data;
    } catch (error) {
      this.logger.error(`Paylov getTransactionStatus: ${error}`);
      return handlePaymentError(error);
    }
  }

  // ─── WEBHOOK ────────────────────────────────────────────────────────────────

  /**
   * Paylov callback'ini HTTP Basic Auth orqali tekshiradi. Paylov rasmiy
   * docsiga ko'ra (developer.paylov.uz/merchant-configuration) merchant
   * kabinetida "Callback Auth username" va "Callback Auth password"
   * o'rnatiladi va Paylov har bir callback so'rovida ularni Basic Auth
   * sifatida yuboradi.
   */
  verifyWebhookBasicAuth(authHeader?: string): boolean {
    if (!this.callbackUsername || !this.callbackPassword) {
      // Sozlanmagan — production'da bu false qaytarish kerak. Hozircha
      // o'tkazib yuboriladi (warning bilan), Paylov dashboardida sozlangach
      // tekshiruv ishlay boshlaydi.
      this.logger.warn(
        'PAYLOV_CALLBACK_USERNAME/PASSWORD sozlanmagan, Basic Auth tekshiruvi o\'tkazib yuborildi',
      );
      return true;
    }
    if (!authHeader || !authHeader.toLowerCase().startsWith('basic ')) return false;

    const expected =
      'Basic ' +
      Buffer.from(`${this.callbackUsername}:${this.callbackPassword}`).toString('base64');

    try {
      const a = Buffer.from(authHeader);
      const b = Buffer.from(expected);
      return a.length === b.length && timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  /**
   * Paylov yuborgan callback'ni qayta ishlash. Agar tranzaksiya holati
   * o'zgargan bo'lsa, audit jadvalini yangilaymiz.
   */
  async handlePaylovCallback(payload: any) {
    const transactionId: string | undefined =
      payload?.transactionId ?? payload?.params?.transactionId ?? payload?.result?.transactionId;
    const state: string | undefined =
      payload?.state ?? payload?.params?.state ?? payload?.result?.state;
    const cancelled: boolean | undefined = payload?.cancelled === true;

    this.logger.log(
      `Paylov callback: tx=${transactionId} state=${state} cancelled=${cancelled}`,
    );

    if (!transactionId) {
      return { result: { acknowledged: true, ignored: 'no_transaction_id' } };
    }

    const tx = await this.txRepository.findOne({
      where: { paylovTransactionId: transactionId },
    });

    if (!tx) {
      this.logger.warn(`Callback for unknown tx ${transactionId}`);
      return { result: { acknowledged: true, ignored: 'unknown_tx' } };
    }

    tx.rawResponse = payload;

    if (cancelled) {
      tx.status = TransactionStatus.DISMISSED;
    } else if (state) {
      const mapped = this.mapPaylovStateToStatus(state);
      if (mapped) tx.status = mapped;
    }

    await this.txRepository.save(tx);
    return { result: { acknowledged: true } };
  }

  /** Paylov state stringlarini bizning enum'imizga o'tkazadi. */
  private mapPaylovStateToStatus(state: string): TransactionStatus | null {
    const s = String(state).toLowerCase();
    if (s.includes('held') || s === '1' || s === 'hold') return TransactionStatus.HELD;
    if (s.includes('charge') || s === '2' || s === 'completed') return TransactionStatus.CHARGED;
    if (s.includes('dismiss') || s === '-1' || s === 'cancelled') {
      return TransactionStatus.DISMISSED;
    }
    if (s.includes('payout') || s === 'paid') return TransactionStatus.PAID_OUT;
    if (s.includes('fail') || s.includes('error')) return TransactionStatus.FAILED;
    return null;
  }

  // ─── ADMIN / RECONCILIATION YORDAMCHI ───────────────────────────────────────

  /** Shartnoma bo'yicha barcha tranzaksiyalarni qaytaradi (audit uchun). */
  async getTransactionsByContract(contractId: number) {
    return this.txRepository.find({
      where: { contractId },
      order: { createdAt: 'DESC' },
    });
  }
}
