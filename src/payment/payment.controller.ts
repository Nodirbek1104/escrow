import { Controller, Post, Get, Body, Param, Delete, UseGuards, Req, HttpCode, HttpStatus, UnauthorizedException } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard'; // Yo'lni tekshiring

@Controller('payment')
@UseGuards(JwtAuthGuard) // Barcha metodlar JWT talab qiladi
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

 @Post('cards/create')
async createCard(@Req() req: any, @Body() body: any) {
  // Eng xavfsiz yo'li: ham 'id', ham 'userId'ni tekshirish
  const userId = req.user?.id || req.user?.userId;

  if (!userId) {
    throw new UnauthorizedException("Foydalanuvchi ma'lumotlari topilmadi. Tokenni tekshiring.");
  }

  return this.paymentService.createCard(userId, body.cardNumber, body.expireDate, body.phoneNumber);
}

  @Post('cards/confirm')
  @HttpCode(HttpStatus.OK)
  async confirmCard(@Req() req: any, @Body() body: { cardId: string; otp: string; cardName: string; pinfl: string }) {
    return this.paymentService.confirmCard(req.user.id, body.cardId, body.otp, body.cardName, body.pinfl);
  }

  @Delete('cards/:cardId')
  async deleteCard(@Req() req: any, @Param('cardId') cardId: string) {
    return this.paymentService.deleteCard(req.user.id, cardId);
  }

  @Get('cards/my')
  async getMyCards(@Req() req: any) {
    return this.paymentService.getMyCards(req.user.id);
  }

  @Get('cards/:cardId/status')
  async getCardStatus(@Req() req: any, @Param('cardId') cardId: string) {
    return this.paymentService.getCardDetails(req.user.id, cardId);
  }

  @Post('cards/check-pnfl')
  @HttpCode(HttpStatus.OK)
  async checkPinfl(@Body() body: { cardId: string; pinfl: string }) {
    return this.paymentService.checkCardData(body.cardId, 'pinfl', body.pinfl);
  }

  @Post('cards/check-phone')
  @HttpCode(HttpStatus.OK)
  async checkPhone(@Body() body: { cardId: string; phone: string }) {
    return this.paymentService.checkCardData(body.cardId, 'phone', body.phone);
  }

  @Post('transactions/cancel')
  @HttpCode(HttpStatus.OK)
  async cancelTransaction(@Body('transactionId') transactionId: string) {
    return this.paymentService.cancelTransaction(transactionId);
  }
  @Post('escrow/hold')
  async hold(@Req() req, @Body() body: { cardId: string; amount: number; contractId: string }) {
    return this.paymentService.holdFunds(req.user.id, body.cardId, body.amount, body.contractId);
  }

  @Post('escrow/fulfill')
  async fulfill(@Body() body: { transactionId: string; receiverCardId: string }) {
    return this.paymentService.fulfillEscrow(body.transactionId, body.receiverCardId);
  }
}