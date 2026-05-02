import { Controller, Post, Get, Body, Param, Delete, UseGuards, Req, HttpCode, HttpStatus, UnauthorizedException, Logger } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Controller('payment')
@UseGuards(JwtAuthGuard)
export class PaymentController {
  private readonly logger = new Logger(PaymentController.name);

  constructor(private readonly paymentService: PaymentService) {}

  @Post('cards/create')
  async createCard(@Req() req: any, @Body() body: any) {
    const userId = req.user?.id || req.user?.userId;
    this.logger.log(`createCard request | userId: ${userId} | body: ${JSON.stringify(body)}`);

    if (!userId) {
      throw new UnauthorizedException("Foydalanuvchi ma'lumotlari topilmadi.");
    }

    const result = await this.paymentService.createCard(userId, body.cardNumber, body.expireDate, body.phoneNumber);
    this.logger.log(`createCard response: ${JSON.stringify(result)}`);
    return result;
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

  @Post('escrow/hold')
  async hold(@Req() req: any, @Body() body: { cardId: string; amount: number; contractId: string }) {
    return this.paymentService.holdFunds(req.user.id, body.cardId, body.amount, body.contractId);
  }

  @Post('escrow/fulfill')
  async fulfill(@Body() body: { transactionId: string; amount: number }) {
    return this.paymentService.fulfillEscrow(body.transactionId, body.amount);
  }

  @Post('escrow/cancel')
  async cancelHold(@Body() body: { transactionId: string }) {
    return this.paymentService.cancelHold(body.transactionId);
  }
}