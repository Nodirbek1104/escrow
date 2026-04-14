import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosError } from 'axios';

@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);
  private cachedToken: string | null = null;
async send(phone: string, message: string): Promise<void> {
    // Test rejimida (yoki developmentda) har doim terminalga chiqarish
    if (process.env.NODE_ENV === 'development' || process.env.SMS_MODE === 'test') {
      console.log('\n🚀 [SMS TEST REJIMI]');
      console.log(`📍 Kimga: ${phone}`);
      console.log(`📝 Matn : ${message}`);
      console.log('----------------------------------------------\n');
      return;
    }

    try {
      await this.sendEskiz(phone, message);
    } catch (error) {
      this.logger.error(`SMS yuborishda xatolik: ${(error as Error).message}`);
    }
  }
private async getAuthToken(forceRefresh = false): Promise<string> {
    // Agar keshda bo'lsa va refresh kerak bo'lmasa, qaytaramiz
    if (this.cachedToken && !forceRefresh) {
      return this.cachedToken;
    }

    try {
      const authRes = await axios.post('https://notify.eskiz.uz/api/auth/login', {
        email: process.env.ESKIZ_EMAIL,
        password: process.env.ESKIZ_SECRET,
      });

      // Tokenni saqlaymiz
      const token = authRes.data.data.token;
      this.cachedToken = token;
      
      return token; // To'g'ridan-to'g'ri yangi olingan tokenni qaytaramiz
    } catch (error) {
      this.logger.error("Eskiz API'dan token olishda xatolik yuz berdi.");
      throw error;
    }
  }
  

  private async sendEskiz(phone: string, message: string, retry = true): Promise<void> {
    try {
      const token = await this.getAuthToken();
      const cleanPhone = phone.replace(/[^\d]/g, '');
      const testmessage = "Bu Eskiz dan test";

      await axios.post(
        'https://notify.eskiz.uz/api/message/sms/send',
        {
          mobile_phone: cleanPhone,
          message: testmessage,
          from: process.env.ESKIZ_FROM ?? '4546',
        },
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      this.logger.log(`SMS muvaffaqiyatli yuborildi: ${cleanPhone}`);
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const axiosError = error as AxiosError<any>;
        
        // Agar token eskirgan bo'lsa (401) va biz hali qayta urinmagan bo'lsak
        if (axiosError.response?.status === 401 && retry) {
          this.logger.warn('Token eskirgan, yangilanmoqda...');
          this.cachedToken = null;
          return this.sendEskiz(phone, message, false); // retry=false cheksiz loopni to'xtatadi
        }
        
        this.logger.error(`Eskiz API xatosi: ${JSON.stringify(axiosError.response?.data)}`);
      }
      throw error;
    }
  }
}