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
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { EscrocontractsService } from './escrocontracts.service';
import { CreateEscrowContractDto } from './dto/create-escrocontract.dto';
import { EscrowStatus } from './entities/escrocontract.entity';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { diskStorage } from 'multer';
import { extname } from 'path';

@Controller('escrow-contracts')
@UseGuards(JwtAuthGuard) // Barcha so'rovlar uchun JWT token talab qilinadi
export class EscrocontractsController {
  constructor(private readonly escrowService: EscrocontractsService) {}

  // ─── 1. SHARTNOMA YARATISH (IJROCHI) ───────────────────────────────────────
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
    // Servisga ma'lumotlarni va fayl yo'lini uzatamiz
    return this.escrowService.create(dto, req.user, file?.path);
  }

  // ─── 2. INVITE TOKENNI TEKSHIRISH (RO'YXATDAN O'TIShDAN OLDIN) ──────────────
  // Bu endpoint xaridor linkni bosganda UI qayerga yo'naltirishni bilishi uchun
  @Get('invite/resolve/:token')
  async resolveInvite(@Param('token') token: string) {
    return this.escrowService.resolveInvite(token);
  }

  // ─── 3. INVITE ORQALI SHARTNOMA TAFSILOTLARINI OLISH ───────────────────────
  @Get('invite/details/:token')
  async getByToken(@Param('token') token: string, @Req() req: any) {
    return this.escrowService.getContractByToken(token, req.user);
  }

  // ─── 4. FOYDALANUVCHINING BARCHA SHARTNOMALARI ─────────────────────────────
  @Get('my-contracts')
  async findAll(@Req() req: any) {
    return this.escrowService.findAllByUser(req.user);
  }

  // ─── 5. STATUSNI YANGILASH (AVTOMATIK HOLD SHU YERDA) ──────────────────────
@Patch(':id/status')
async updateStatus(
  @Param('id', ParseIntPipe) id: number,
  @Body('status') status: EscrowStatus,
  @Req() req: any, // Majburiy parametr oldinga o'tdi ✅
  @Body('cardId') cardId?: string, // Ixtiyoriy - oxirida ✅
  @Body('reason') reason?: string, // Ixtiyoriy - oxirida ✅
) {
  return this.escrowService.updateStatus(id, status, req.user, {
    cardId,
    reason,
  });
}

  // ─── 6. BITTASINI ID ORQALI KO'RISH ────────────────────────────────────────
  @Get(':id')
  async findOne(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.escrowService.findOne(id, req.user);
  }

  // ─── 7. SHARTNOMANI TAHRIRLASH ─────────────────────────────────────────────
  @Patch(':id/update')
  @UseInterceptors(FileInterceptor('file'))
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: any,
    @Req() req: any,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.escrowService.update(id, dto, req.user, file?.path);
  }

  // ─── 8. BEKOR QILISH (UNHOLD BILAN) ────────────────────────────────────────
  @Delete(':id/cancel')
  async cancel(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.escrowService.cancel(id, req.user);
  }
}