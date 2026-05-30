import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Delete,
  Query,
  Res,
  UseGuards,
  Req,
  HttpCode,
  HttpStatus,
  UnauthorizedException,
  BadRequestException,
  Logger,
  Headers,
  ParseIntPipe,
} from '@nestjs/common';
import type { Response } from 'express';
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

  @UseGuards(JwtAuthGuard)
  @Get('contracts/:contractId/transactions')
  async contractTransactions(
    @Req() req: any,
    @Param('contractId', ParseIntPipe) contractId: number,
  ) {
    return this.paymentService.getTransactionsByContract(contractId, req.user);
  }

  /** ADMIN: pending or failed payouts that may need manual intervention. */
  @UseGuards(JwtAuthGuard, AdminGuard)
  @Get('admin/payouts/queue')
  async payoutQueue() {
    return this.paymentService.getPayoutQueue();
  }

  /** ADMIN: full financial reconciliation across every contract. */
  @UseGuards(JwtAuthGuard, AdminGuard)
  @Get('admin/reconciliation')
  async reconciliation() {
    return this.paymentService.runReconciliation();
  }

  /** ADMIN: financial audit for a single contract. */
  @UseGuards(JwtAuthGuard, AdminGuard)
  @Get('admin/reconciliation/:contractId')
  async reconciliationOne(
    @Param('contractId', ParseIntPipe) contractId: number,
  ) {
    return this.paymentService.auditOneContract(contractId);
  }

  /** ADMIN: approve a parked payout (sends it to Paylov). */
  @UseGuards(JwtAuthGuard, AdminGuard)
  @Post('admin/payouts/:txId/approve')
  async approvePayout(@Req() req: any, @Param('txId') txId: string) {
    return this.paymentService.approvePayout(txId, req.user.userId);
  }

  /** ADMIN: deny a parked payout (records the rejection, marks contract DISPUTED). */
  @UseGuards(JwtAuthGuard, AdminGuard)
  @Post('admin/payouts/:txId/deny')
  async denyPayout(
    @Req() req: any,
    @Param('txId') txId: string,
    @Body() body: { reason?: string },
  ) {
    if (!body?.reason || !body.reason.trim()) {
      throw new BadRequestException('Rad etish sababi kerak');
    }
    return this.paymentService.denyPayout(
      txId,
      req.user.userId,
      body.reason,
    );
  }

  /** ADMIN: payment transactions CSV export (optional from/to/type/status). */
  @UseGuards(JwtAuthGuard, AdminGuard)
  @Get('admin/transactions/export.csv')
  async exportTransactionsCsv(
    @Res() res: Response,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('type') type?: string,
    @Query('status') status?: string,
  ) {
    const csv = await this.paymentService.exportTransactionsCsv({
      from,
      to,
      type,
      status,
    });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="escro-transactions-${stamp}.csv"`,
    );
    res.send(csv);
  }

  // ─── PAYLOV WEBHOOK (ochiq endpoint) ─────────────────────────────────────────

  /**
   * Paylov tomonidan yuboriladigan callback. Paylov rasmiy docsiga ko'ra
   * autentifikatsiya HTTP Basic Auth orqali amalga oshiriladi:
   * Authorization: Basic base64(PAYLOV_CALLBACK_USERNAME:PAYLOV_CALLBACK_PASSWORD).
   * Username/password Paylov merchant kabinetida sozlanadi va serverda env
   * sifatida saqlanadi.
   */
  @Post('paylov/callback')
  @HttpCode(HttpStatus.OK)
  async paylovCallback(
    @Headers('authorization') authHeader: string | undefined,
    @Body() body: any,
  ) {
    const ok = this.paymentService.verifyWebhookBasicAuth(authHeader);
    if (!ok) {
      this.logger.warn('Paylov webhook: invalid Basic Auth credentials');
      throw new UnauthorizedException('Invalid credentials');
    }

    return this.paymentService.handlePaylovCallback(body);
  }
}
