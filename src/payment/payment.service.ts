import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import axios, { AxiosInstance } from 'axios';
import { Card } from './entities/payment.entity';
import { handlePaymentError } from './utils/payment-error.handler';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class PaymentService {
  private readonly client: AxiosInstance;
  private readonly logger = new Logger(PaymentService.name);

 constructor(
    @InjectRepository(Card)
    private cardRepository: Repository<Card>,
    private configService: ConfigService, // ConfigService-ni inject qiling
  ) {
    const baseUrl = this.configService.get<string>('PAYLOV_BASE_URL');
    const token = this.configService.get<string>('PAYLOV_TOKEN');
    const merchantId = this.configService.get<string>('PAYLOV_MERCHANT_ID');

    // Debug uchun: agar birortasi bo'sh bo'lsa, logda ko'rasiz
    if (!baseUrl) {
      console.error('DIQQAT: PAYLOV_BASE_URL topilmadi!');
    }

    this.client = axios.create({
      baseURL: baseUrl,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Merchant-Id': merchantId,
        'Content-Type': 'application/json',
      },
    });
  }

  // 1. Create Card - Karta ulanishini boshlash
 async createCard(userId: number | string, cardNumber: string, expireDate: string, phoneNumber: string) {
    try {
      // Xavfsizlik uchun userId borligini tekshiramiz
      if (!userId) {
        throw new BadRequestException('Foydalanuvchi ID-si (userId) taqdim etilmadi');
      }

      const { data } = await this.client.post('/cards/create', {
        // userId har doim string bo'lishini ta'minlaymiz
        userId: String(userId), 
        cardNumber: cardNumber.replace(/\s+/g, ''), // Probellarni olib tashlaydi
        expireDate: expireDate.replace(/\//g, ''),  // 12/26 -> 1226 formatga o'tkazadi
        phoneNumber: phoneNumber.replace(/\+/g, ''), // + belgisini olib tashlaydi
      });

      return data;
    } catch (error) {
      this.logger.error(`Paylov API Error: ${error}`);
      
      // Invalid URL yoki boshqa tizim xatolarini ushlash
      if (error instanceof TypeError && error.message.includes('Invalid URL')) {
        return {
          status: 'error',
          message: ".env faylida PAYLOV_BASE_URL noto'g'ri ko'rsatilgan",
        };
      }

      // Tashqi funksiya orqali xatolikni qayta ishlash
      return handlePaymentError(error);
    }
  }

  // 2. Confirm Card - OTP kod orqali tasdiqlash va DBga saqlash
  async confirmCard(userId: number, cardId: string, otp: string, cardName: string, pinfl: string) {
    try {
      const { data } = await this.client.post('/cards/confirm', {
        cardId,
        otp,
        cardName,
        pinfl,
      });

      // 1. API dan muvaffaqiyatli javob kelsa va karta ma'lumotlari bo'lsa
      if (data.result && data.result.card) {
        const c = data.result.card;

        // 2. Bazada bu karta oldin bor-yo'qligini tekshiramiz
        const existingCard = await this.cardRepository.findOne({ where: { cardId: c.cardId } });

        if (existingCard) {
          // 3. Agar bo'lsa, ma'lumotlarini yangilaymiz
          await this.cardRepository.update(
            { cardId: c.cardId },
            { 
              balance: c.balance, 
              isActive: c.status?.is_active ?? true,
              statusMessage: c.status?.status_message 
            }
          );
        } else {
          // 4. Agar yo'q bo'lsa, yangi yaratamiz
          const newCard = this.cardRepository.create({
            cardId: c.cardId,
            userId: userId,
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
      // Markazlashgan xato boshqaruvchisi
      return handlePaymentError(error);
    }
  }

  // 3. Delete Card - API va DBdan o'chirish
  async deleteCard(userId: number, cardId: string) {
    try {
      // Avval karta aynan shu userga tegishliligini tekshiramiz
      const card = await this.cardRepository.findOne({ where: { cardId, userId } });
      if (!card) {
        return { result: null, error: { code: 'card_not_found', message: 'Karta topilmadi' } };
      }

      const { data } = await this.client.post('/cards/delete', { cardId });
      if (data.result === true) {
        await this.cardRepository.remove(card);
      }
      return data;
    } catch (error) {
      return handlePaymentError(error);
    }
  }

  // 4. Get User Cards - Faqat DBdan o'qish (Tezroq ishlash uchun)
// 4. Get User Cards
  async getMyCards(userId: number) {
    try {
      const cards = await this.cardRepository.find({ 
        where: { userId },
        order: { createdAt: 'DESC' } 
      });
      return { result: { cards }, error: null };
    } catch (error: unknown) { // Bu yerda 'unknown' turibdi
      // Error-ni 'any' yoki 'Error' tipiga cast qilamiz
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      this.logger.error(`DB Get Cards Error: ${errorMessage}`);
      
      return { 
        result: null, 
        error: { 
          code: 'db_error', 
          message: errorMessage 
        } 
      };
    }
  }

  // 5. Get Single Card Status - Paylovdan real-vaqtdagi balansni olish
  async getCardDetails(userId: number, cardId: string) {
    try {
      const cardExists = await this.cardRepository.findOne({ where: { cardId, userId } });
      if (!cardExists) throw new Error('Permission denied');

      const { data } = await this.client.get(`/cards/get/${cardId}`);
      return data;
    } catch (error) {
      return handlePaymentError(error);
    }
  }

  // 6. Check PINFL & Phone Match
  async checkCardData(cardId: string, type: 'pinfl' | 'phone', value: string) {
    try {
      const endpoint = type === 'pinfl' ? '/cards/check-pnfl' : '/cards/check-phone-match';
      const payload = type === 'pinfl' ? { cardId, pinfl: value } : { cardId, phone: value };
      
      const { data } = await this.client.post(endpoint, payload);
      return data;
    } catch (error) {
      return handlePaymentError(error);
    }
  }

  // 7. Cancel Transaction
  async cancelTransaction(transactionId: string) {
    try {
      const { data } = await this.client.post('/transactions/cancel', { transactionId });
      return data;
    } catch (error) {
      return handlePaymentError(error);
    }
  }

  // 1. Pulni muzlatish (Hold / Create Transaction)
  async holdFunds(userId: number, cardId: string, amount: number, contractId: string) {
    try {
      // Avval karta shu userga tegishliligini tekshiramiz
      const card = await this.cardRepository.findOne({ where: { cardId, userId } });
      if (!card) throw new Error("Karta topilmadi yoki ruxsat yo'q");

      const { data } = await this.client.post('/transactions/create', {
        cardId,
        amount: amount * 100, // So'mni tiyinga o'tkazish (masalan: 1000 so'm = 100000 tiyin)
        description: `Escrow Contract #${contractId} uchun muzlatish`,
        extId: `contract_${contractId}_${Date.now()}`, // Takrorlanmas ID
      });

      return data; // data.result.transactionId ni bazaga saqlab qo'yish kerak
    } catch (error) {
      return handlePaymentError(error);
    }
  }

  // 2. Muzlatilgan pulni sotuvchiga o'tkazish (Complete / P2P)
  async fulfillEscrow(transactionId: string, receiverCardId: string) {
    try {
      // Paylovda bu ko'pincha tranzaksiyani yakunlash yoki 
      // yangi P2P o'tkazmasini amalga oshirish orqali bo'ladi
      const { data } = await this.client.post('/transactions/confirm', {
        transactionId,
        receiverCardId, // Pul borib tushishi kerak bo'lgan karta IDsi
      });

      return data;
    } catch (error) {
      return handlePaymentError(error);
    }
  }
}