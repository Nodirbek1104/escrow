import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Req,
  Res,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname, join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import type { Response } from 'express';
import { KycService } from './kyc.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdminGuard } from '../auth/guards/admin.guard';

const KYC_UPLOAD_DIR = join(process.cwd(), 'uploads', 'kyc');

if (!existsSync(KYC_UPLOAD_DIR)) {
  mkdirSync(KYC_UPLOAD_DIR, { recursive: true });
}

const kycMulterOptions = {
  storage: diskStorage({
    destination: KYC_UPLOAD_DIR,
    filename: (_req: any, file: Express.Multer.File, cb: any) => {
      const unique =
        Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
      cb(null, `${unique}${extname(file.originalname).toLowerCase()}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB per file
  fileFilter: (_req: any, file: Express.Multer.File, cb: any) => {
    const ok = /^image\/(png|jpe?g|gif|webp|heic)$/i.test(file.mimetype);
    if (!ok) {
      return cb(
        new BadRequestException('Faqat rasm fayllari qabul qilinadi'),
        false,
      );
    }
    cb(null, true);
  },
};

@Controller('kyc')
export class KycController {
  constructor(private readonly kyc: KycService) {}

  // ─── User-facing ─────────────────────────────────────────────────────────
  @UseGuards(JwtAuthGuard)
  @Get('status')
  async myStatus(@Req() req: any) {
    return this.kyc.getStatus(req.user.userId);
  }

  @UseGuards(JwtAuthGuard)
  @Post('upload')
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'idFront', maxCount: 1 },
        { name: 'idBack', maxCount: 1 },
        { name: 'selfie', maxCount: 1 },
      ],
      kycMulterOptions,
    ),
  )
  async upload(
    @Req() req: any,
    @UploadedFiles()
    files: {
      idFront?: Express.Multer.File[];
      idBack?: Express.Multer.File[];
      selfie?: Express.Multer.File[];
    },
  ) {
    return this.kyc.submit(req.user.userId, {
      id_front: files.idFront?.[0],
      id_back: files.idBack?.[0],
      selfie: files.selfie?.[0],
    });
  }

  // Files are referenced with random base36 names; serve them without auth
  // so that <img> tags can render directly. (Auth is added later if needed.)
  @Get('file/:fname')
  serveFile(@Param('fname') fname: string, @Res() res: Response) {
    if (fname.includes('/') || fname.includes('..')) {
      throw new BadRequestException('Fayl nomi noto‘g‘ri');
    }
    const fp = join(KYC_UPLOAD_DIR, fname);
    if (!existsSync(fp)) {
      res.status(404).json({ message: 'Fayl topilmadi' });
      return;
    }
    res.sendFile(fp);
  }
}

@Controller('admin/kyc')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminKycController {
  constructor(private readonly kyc: KycService) {}

  @Get('pending')
  listPending() {
    return this.kyc.listPending();
  }

  @Get(':userId')
  getOne(@Param('userId', ParseIntPipe) userId: number) {
    return this.kyc.getForAdmin(userId);
  }

  @Post(':userId/approve')
  approve(@Req() req: any, @Param('userId', ParseIntPipe) userId: number) {
    return this.kyc.approve(userId, req.user.userId);
  }

  @Post(':userId/reject')
  reject(
    @Req() req: any,
    @Param('userId', ParseIntPipe) userId: number,
    @Body() body: { reason?: string },
  ) {
    if (!body?.reason || !body.reason.trim()) {
      throw new BadRequestException('Rad etish sababi kerak');
    }
    return this.kyc.reject(userId, req.user.userId, body.reason);
  }
}
