import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  Req,
  UploadedFile,
  UseInterceptors,
  ParseIntPipe,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { EscrocontractsService } from './escrocontracts.service';
import { CreateEscrowContractDto } from './dto/create-escrocontract.dto';
import { EscrowStatus } from './entities/escrocontract.entity';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard'; // O'zingizning Guard manzilingiz
import { diskStorage } from 'multer';
import { extname } from 'path';

@Controller('escrow-contracts')
@UseGuards(JwtAuthGuard) // Barcha endpointlar uchun login talab qilinadi
export class EscrocontractsController {
  constructor(private readonly escrowService: EscrocontractsService) {}

  // 1. Shartnoma yaratish (Fayl bilan)
  @Post()
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: './uploads/contracts',
        filename: (req, file, cb) => {
          const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
          cb(null, `${uniqueSuffix}${extname(file.originalname)}`);
        },
      }),
    }),
  )
  async create(
    @Body() dto: CreateEscrowContractDto,
    @Req() req: any,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.escrowService.create(dto, req.user, file?.path);
  }

  // 2. Foydalanuvchining barcha shartnomalari
  @Get('my')
  async findAll(@Req() req: any) {
    return this.escrowService.findAllByUser(req.user);
  }

  // 3. Invite Linkni tekshirish (Ochiq endpoint bo'lishi mumkin, lekin Guard bor)
  @Get('invite/:token')
  async resolveInvite(@Param('token') token: string) {
    return this.escrowService.resolveInvite(token);
  }

  // 4. Invite orqali shartnoma ma'lumotlarini olish
  @Get('invite/:token/details')
  async getByToken(@Param('token') token: string, @Req() req: any) {
    return this.escrowService.getContractByToken(token, req.user);
  }

  // 5. Bittasini ko'rish
  @Get(':id')
  async findOne(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.escrowService.findOne(id, req.user);
  }

  // 6. Statusni yangilash (ACCEPTED, REJECTED, REVISION, COMPLETED)
  @Patch(':id/status')
  async updateStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body('status') status: EscrowStatus,
    @Body('reason') reason: string,
    @Body('cardId') cardId: string, // ACCEPTED holati uchun kerak
    @Req() req: any,
  ) {
    return this.escrowService.updateStatus(id, status, req.user, {
      reason,
      cardId,
    });
  }

  // 7. Pulni muzlatish (Xaridor to'lov qilganda)
  @Post(':id/hold-payment')
  async holdPayment(
    @Param('id', ParseIntPipe) id: number,
    @Body('cardId') cardId: string,
    @Req() req: any,
  ) {
    return this.escrowService.holdContractPayment(id, req.user, cardId);
  }

  // 8. Tahrirlash
  @Patch(':id')
  @UseInterceptors(FileInterceptor('file'))
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: any,
    @Req() req: any,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.escrowService.update(id, dto, req.user, file?.path);
  }

  // 9. Bekor qilish
  @Delete(':id/cancel')
  async cancel(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.escrowService.cancel(id, req.user);
  }
}