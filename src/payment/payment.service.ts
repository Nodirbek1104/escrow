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
    private configService: ConfigService,
  ) {
    const baseUrl = this.configService.get<string>('PAYLOV_BASE_URL');
    const token = this.configService.get<string>('PAYLOV_TOKEN');
    const merchantId = this.configService.get<string>('PAYLOV_MERCHANT_ID');

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
      if (!userId) {
        throw new BadRequestException('Foydalanuvchi ID-si taqdim etilmadi');
      }

      // Paylov expects YYMM format (e.g., 2803 for March 2028)
      // Our input is MM/YY (e.g., 03/28)
      const parts = expireDate.split('/');
      const formattedExpiry = parts.length === 2 ? parts[1].trim() + parts[0].trim() : expireDate.replace(/\//g, '');

      // Correct endpoint: /merchant/userCard/createUserCard/
      const { data } = await this.client.post('/merchant/userCard/createUserCard/', {
        userId: String(userId),
        cardNumber: cardNumber.replace(/\s+/g, ''),
        expireDate: formattedExpiry,
        phoneNumber: phoneNumber.startsWith('+') ? phoneNumber : '+' + phoneNumber.replace(/\D/g, ''),
      });

      return data;
    } catch (error) {
      this.logger.error(`Paylov API Error (createCard): ${error}`);
      return handlePaymentError(error);
    }
  }

  // 2. Confirm Card - OTP kod orqali tasdiqlash
  async confirmCard(userId: number, cardId: string, otp: string, cardName: string, pinfl: string) {
    try {
      // Correct endpoint: /merchant/userCard/confirmUserCardCreate/
      const { data } = await this.client.post('/merchant/userCard/confirmUserCardCreate/', {
        cardId, // This is the 'cid' from createCard
        otp,
      });

      if (data.result && data.result.card) {
        const c = data.result.card;
        const existingCard = await this.cardRepository.findOne({ where: { cardId: c.cardId } });

        if (existingCard) {
          await this.cardRepository.update(
            { cardId: c.cardId },
            { 
              balance: c.balance, 
              isActive: c.status?.is_active ?? true,
              statusMessage: c.status?.status_message 
            }
          );
        } else {
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
      this.logger.error(`Paylov API Error (confirmCard): ${error}`);
      return handlePaymentError(error);
    }
  }

  // 3. Delete Card
  async deleteCard(userId: number, cardId: string) {
    try {
      const card = await this.cardRepository.findOne({ where: { cardId, userId } });
      if (!card) {
        return { result: null, error: { code: 'card_not_found', message: 'Karta topilmadi' } };
      }

      // Correct endpoint: /merchant/userCard/deleteUserCard/ (DELETE method with query param)
      const { data } = await this.client.delete(`/merchant/userCard/deleteUserCard/`, {
        params: { userCardId: cardId }
      });

      if (data.result === true) {
        await this.cardRepository.remove(card);
      }
      return data;
    } catch (error) {
      return handlePaymentError(error);
    }
  }

  // 4. Get User Cards
  async getMyCards(userId: number) {
    try {
      return await this.cardRepository.find({ 
        where: { userId },
        order: { createdAt: 'DESC' } 
      });
    } catch (error) {
      return [];
    }
  }

  // 5. Get Card Details
  async getCardDetails(userId: number, cardId: string) {
    try {
      const cardExists = await this.cardRepository.findOne({ where: { cardId, userId } });
      if (!cardExists) throw new Error('Permission denied');

      // Correct endpoint: /merchant/userCard/getCard/{cardId}/
      const { data } = await this.client.get(`/merchant/userCard/getCard/${cardId}/`);
      return data;
    } catch (error) {
      return handlePaymentError(error);
    }
  }

  // 6. Hold Funds (Create Transaction)
  async holdFunds(userId: number, cardId: string, amount: number, contractId: string) {
    try {
      const card = await this.cardRepository.findOne({ where: { cardId, userId } });
      if (!card) throw new Error("Karta topilmadi yoki ruxsat yo'q");

      // Correct endpoint: /payment/hold/create/
      // Paylov expects amount in SUM (based on docs), but double check if tiyin is needed.
      // Duration set to 28 days (max) in minutes.
      const { data } = await this.client.post('/payment/hold/create/', {
        userId: String(userId),
        cardId,
        amount: amount, 
        time: 40320, 
        description: `Escrow Contract #${contractId}`,
        extId: `contract_${contractId}_${Date.now()}`,
      });

      return data;
    } catch (error) {
      this.logger.error(`Paylov API Error (holdFunds): ${error}`);
      return handlePaymentError(error);
    }
  }

  // 7. Fulfill Escrow (Charge Hold)
  async fulfillEscrow(transactionId: string, amount: number) {
    try {
      // Correct endpoint: /payment/hold/charge/
      const { data } = await this.client.post('/payment/hold/charge/', {
        transactionId,
        amount: amount,
      });

      return data;
    } catch (error) {
      this.logger.error(`Paylov API Error (fulfillEscrow): ${error}`);
      return handlePaymentError(error);
    }
  }

  // 8. Cancel Hold (Dismiss Hold)
  async cancelHold(transactionId: string) {
    try {
      // Correct endpoint: /payment/hold/dismiss/
      const { data } = await this.client.post('/payment/hold/dismiss/', {
        transactionId,
      });

      return data;
    } catch (error) {
      this.logger.error(`Paylov API Error (cancelHold): ${error}`);
      return handlePaymentError(error);
    }
  }
}