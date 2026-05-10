import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname, join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import type { Response } from 'express';
import { DisputeEvidenceService } from './dispute-evidence.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

const EVIDENCE_DIR = join(process.cwd(), 'uploads', 'evidence');
if (!existsSync(EVIDENCE_DIR)) mkdirSync(EVIDENCE_DIR, { recursive: true });

const evidenceMulterOptions = {
  storage: diskStorage({
    destination: EVIDENCE_DIR,
    filename: (_req: any, file: Express.Multer.File, cb: any) => {
      const unique =
        Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
      cb(null, `${unique}${extname(file.originalname).toLowerCase()}`);
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB per file
  fileFilter: (_req: any, file: Express.Multer.File, cb: any) => {
    const ok =
      /^image\/(png|jpe?g|gif|webp|heic)$/i.test(file.mimetype) ||
      file.mimetype === 'application/pdf' ||
      /^video\/(mp4|quicktime|webm)$/i.test(file.mimetype);
    if (!ok) {
      return cb(
        new BadRequestException(
          'Faqat rasm, PDF yoki video fayllar qabul qilinadi',
        ),
        false,
      );
    }
    cb(null, true);
  },
};

@Controller('escrow-contracts')
@UseGuards(JwtAuthGuard)
export class DisputeEvidenceController {
  constructor(private readonly svc: DisputeEvidenceService) {}

  @Post(':id/evidence')
  @UseInterceptors(FileInterceptor('file', evidenceMulterOptions))
  upload(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: any,
    @UploadedFile() file: Express.Multer.File,
    @Body('note') note?: string,
  ) {
    return this.svc.upload(id, req.user.userId, file, note);
  }

  @Get(':id/evidence')
  list(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.svc.list(id, req.user);
  }

  @Delete(':id/evidence/:evidenceId')
  remove(
    @Param('id', ParseIntPipe) id: number,
    @Param('evidenceId') evidenceId: string,
    @Req() req: any,
  ) {
    return this.svc.softDelete(id, evidenceId, req.user.userId);
  }

  // Static file streamer — random filenames, files referenced from FE
  // <img>/<video>/<a> tags. No auth on this route so the browser can fetch
  // them directly; if leakage becomes a concern, gate via signed URL later.
  @Get('evidence/file/:fname')
  serve(@Param('fname') fname: string, @Res() res: Response) {
    if (fname.includes('/') || fname.includes('..')) {
      throw new BadRequestException('Fayl nomi noto‘g‘ri');
    }
    const fp = join(EVIDENCE_DIR, fname);
    if (!existsSync(fp)) {
      res.status(404).json({ message: 'Fayl topilmadi' });
      return;
    }
    res.sendFile(fp);
  }
}
