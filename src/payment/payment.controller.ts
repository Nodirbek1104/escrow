import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Delete,
  UseGuards,
  Req,
  HttpCode,
  HttpStatus,
  UnauthorizedException,
  Logger,
  Headers,
  ParseIntPipe,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { PaymentService } from './payment.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdminGuard } from '../auth/guards/admin.guard';
import {
  CreateCardDto,
  ConfirmCardDto,
  ResendOtpDto,
  HoldFundsDto,
  FulfillEscrowDto,
  CancelHoldDto,
  PayoutDto,
} from './dto/create-payment.dto';

@Controller('payment')
export class PaymentController {
  private readonly logger = new Logger(PaymentController.name);

  constructor(private readonly paymentService: PaymentService) {}

  // ─── KARTA AMALLARI ──────────────────────────────────────────────────────────

  @UseGuards(JwtAuthGuard)
  @Post('cards/create')
  @HttpCode(HttpStatus.OK)
  async createCard(@Req() req: any, @Body() body: CreateCardDto) {
    const userId = req.user?.id || req.user?.userId;
    if (!userId) {
      throw new UnauthorizedException("Foydalanuvchi ma'lumotlari topilmadi.");
    }
    this.logger.log(`createCard | userId=${userId}`);
    return this.paymentService.createCard(
      userId,
      body.cardNumber,
      body.expireDate,
      body.phoneNumber,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post('cards/confirm')
  @HttpCode(HttpStatus.OK)
  async confirmCard(@Req() req: any, @Body() body: ConfirmCardDto) {
    const userId = req.user?.id || req.user?.userId;
    return this.paymentService.confirmCard(
      userId,
      body.cardId,
      body.otp,
      body.cardName,
      body.pinfl,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post('cards/resend-otp')
  @HttpCode(HttpStatus.OK)
  async resendOtp(@Body() body: ResendOtpDto) {
    return this.paymentService.resendOtp(body.cardId);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('cards/:cardId')
  async deleteCard(@Req() req: any, @Param('cardId') cardId: string) {
    const userId = req.user?.id || req.user?.userId;
    return this.paymentService.deleteCard(userId, cardId);
  }

  @UseGuards(JwtAuthGuard)
  @Get('cards/my')
  async getMyCards(@Req() req: any) {
    const userId = req.user?.id || req.user?.userId;
    return this.paymentService.getMyCards(userId);
  }

  @UseGuards(JwtAuthGuard)
  @Get('cards/:cardId/status')
  async getCardStatus(@Req() req: any, @Param('cardId') cardId: string) {
    const userId = req.user?.id || req.user?.userId;
    return this.paymentService.getCardDetails(userId, cardId);
  }

  // ─── ESCROW: HOLD / CHARGE / DISMISS / PAYOUT ────────────────────────────────

  @UseGuards(JwtAuthGuard)
  @Post('escrow/hold')
  @HttpCode(HttpStatus.OK)
  async hold(@Req() req: any, @Body() body: HoldFundsDto) {
    const userId = req.user?.id || req.user?.userId;
    return this.paymentService.holdFunds(userId, body.cardId, body.amount, body.contractId);
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Post('escrow/fulfill')
  @HttpCode(HttpStatus.OK)
  async fulfill(@Body() body: FulfillEscrowDto) {
    return this.paymentService.fulfillEscrow(body.transactionId, body.amount);
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Post('escrow/cancel')
  @HttpCode(HttpStatus.OK)
  async cancelHold(@Body() body: CancelHoldDto) {
    return this.paymentService.cancelHold(body.transactionId);
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Post('escrow/payout')
  @HttpCode(HttpStatus.OK)
  async payout(@Body() body: PayoutDto) {
    return this.paymentService.payoutToCard(body.toCardId, body.amount, body.contractId);
  }

  // ─── RECONCILIATION ──────────────────────────────────────────────────────────

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Get('transactions/:transactionId/status')
  async transactionStatus(@Param('transactionId') transactionId: string) {
    return this.paymentService.getTransactionStatus(transactionId);
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Get('contracts/:contractId/transactions')
  async contractTransactions(@Param('contractId', ParseIntPipe) contractId: number) {
    return this.paymentService.getTransactionsByContract(contractId);
  }

  // ─── PAYLOV WEBHOOK (ochiq endpoint) ─────────────────────────────────────────

  /**
   * Paylov tomonidan yuboriladigan callback. Auth talab qilinmaydi, lekin
   * imzo (HMAC-SHA256) PAYLOV_WEBHOOK_SECRET orqali tekshiriladi.
   *
   * Header nomi va imzolash sxemasi docs.paylov.uz da tasdiqlanishi kerak.
   * Hozircha `X-Paylov-Signature` (yoki `paylov-signature`) header'i kutiladi.
   */
  @Post('paylov/callback')
  @HttpCode(HttpStatus.OK)
  async paylovCallback(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-paylov-signature') sigHeader1: string | undefined,
    @Headers('paylov-signature') sigHeader2: string | undefined,
    @Body() body: any,
  ) {
    const signature = sigHeader1 || sigHeader2;
    const rawBody = req.rawBody?.toString('utf8') ?? JSON.stringify(body);

    const ok = this.paymentService.verifyWebhookSignature(rawBody, signature);
    if (!ok) {
      this.logger.warn('Paylov webhook: signature mismatch');
      // Paylov ko'p hollarda 200 kutadi, aks holda retry qiladi.
      // Lekin noto'g'ri imzoda 401 qaytarish to'g'ri xatti-harakat.
      throw new UnauthorizedException('Invalid signature');
    }

    return this.paymentService.handlePaylovCallback(body);
  }
}
