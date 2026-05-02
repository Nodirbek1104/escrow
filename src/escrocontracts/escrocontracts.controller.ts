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
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { diskStorage } from 'multer';
import { extname } from 'path';
import { AuditInterceptor } from '../audit-log/audit-log.interceptor';
import { AdminGuard } from '../auth/guards/admin.guard';

@Controller('escrow-contracts')
@UseInterceptors(AuditInterceptor)
export class EscrocontractsController {
  constructor(private readonly escrowService: EscrocontractsService) {}

  // 1. CREATE
  @UseGuards(JwtAuthGuard)
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

  // 2. MY CONTRACTS (Statik yo'llar har doim tepada bo'lishi kerak!)
  @UseGuards(JwtAuthGuard)
  @Get('my-contracts')
  async findAll(@Req() req: any) {
    return this.escrowService.findAllByUser(req.user);
  }

  // 3. INVITE RESOLVE
  @Get('invite/resolve/:token')
  async resolveInvite(@Param('token') token: string) {
    return this.escrowService.resolveInvite(token);
  }

  // 4. INVITE DETAILS
  @Get('invite/details/:token')
  async getByToken(@Param('token') token: string, @Req() req: any) {
    return this.escrowService.getContractByToken(token, req.user);
  }

  // 5. UPDATE STATUS (Majburiy parametrlar oldinda)
  @UseGuards(JwtAuthGuard)
  @Patch(':id/status')
  async updateStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body('status') status: EscrowStatus,
    @Req() req: any,
    @Body('cardId') cardId?: string,
    @Body('reason') reason?: string,
  ) {
    return this.escrowService.updateStatus(id, status, req.user, {
      cardId,
      reason,
    });
  }

  // 6. UPDATE (EDIT)
  @UseGuards(JwtAuthGuard)
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

  // 9. ADMIN: ALL CONTRACTS
  @Get('admin/all')
  @UseGuards(JwtAuthGuard, AdminGuard)
  async findAllAdmin() {
    return this.escrowService.findAllAdmin();
  }

  // 7. FIND ONE (Dinamik :id oxirida bo'lishi xavfsizroq)
  @UseGuards(JwtAuthGuard)
  @Get(':id')
  async findOne(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.escrowService.findOne(id, req.user);
  }

  // 8. CANCEL
  @UseGuards(JwtAuthGuard)
  @Delete(':id/cancel')
  async cancel(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.escrowService.cancel(id, req.user);
  }
}