
import {
  Controller, Get, Post, Body, Patch, Param,
  UseGuards, Req, UseInterceptors, UploadedFile,
  ParseIntPipe,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname } from 'path';

import { EscrocontractsService } from './escrocontracts.service';
import { CreateEscrowContractDto } from './dto/create-escrocontract.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { EscrowStatus } from './entities/escrocontract.entity';
import { AuditInterceptor } from '../audit-log/audit-log.interceptor';

const contractFileInterceptor = FileInterceptor('file', {
  storage: diskStorage({
    destination: './uploads/contracts',
    filename: (req, file, cb) => {
      const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      cb(null, `contract-${unique}${extname(file.originalname)}`);
    },
  }),
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.doc', '.docx', '.jpg', '.jpeg', '.png'];
    const ext = extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Ruxsat etilmagan fayl turi: ${ext}`), false);
    }
  },
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});
@UseInterceptors(AuditInterceptor)
@Controller('escro-contract')
export class EscrowContractController {
  constructor(private readonly escrowService: EscrocontractsService) {}

  // 1. Shartnoma yaratish (JWT kerak)
  @Post()
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(contractFileInterceptor)
  create(
    @Body() dto: CreateEscrowContractDto,
    @Req() req,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.escrowService.create(dto, req.user, file?.path);
  }

  // 2. Invite token tekshirish (JWT SHART EMAS)
  @Get('invite/:token')
  resolveInvite(@Param('token') token: string) {
    return this.escrowService.resolveInvite(token);
  }

  // 3. Token orqali shartnomani ochish (JWT kerak)
  @Get('invite/:token/contract')
  @UseGuards(JwtAuthGuard)
  getContractByToken(@Param('token') token: string, @Req() req) {
    return this.escrowService.getContractByToken(token, req.user);
  }

  // 4. O'zining shartnomalar ro'yxati
  @Get('my-documents')
  @UseGuards(JwtAuthGuard)
  findAll(@Req() req) {
    return this.escrowService.findAllByUser(req.user);
  }

  // 5. Batafsil ko'rish
  @Get(':id')
  @UseGuards(JwtAuthGuard)
  findOne(@Param('id', ParseIntPipe) id: number, @Req() req) {
    return this.escrowService.findOne(id, req.user);
  }

  // 6. Status yangilash
  @Patch(':id/status')
  @UseGuards(JwtAuthGuard)
  updateStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body('status') status: EscrowStatus,
    @Body('reason') reason: string,
    @Req() req,
  ) {
    return this.escrowService.updateStatus(id, status, req.user, reason);
  }

  // 7. Bekor qilish
  @Patch(':id/cancel')
  @UseGuards(JwtAuthGuard)
  cancel(@Param('id', ParseIntPipe) id: number, @Req() req) {
    return this.escrowService.cancel(id, req.user);
  }

  // 8. Tahrirlash
  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(contractFileInterceptor)
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: Partial<CreateEscrowContractDto>,
    @Req() req,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.escrowService.update(id, dto, req.user, file?.path);
  }
}