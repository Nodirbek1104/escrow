import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Post,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  ParseIntPipe,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname, join } from 'path';
import { existsSync } from 'fs';
import type { Response } from 'express';
import { MessagesService } from './messages.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TelegramGuard } from '../auth/guards/telegram.guard';

const MESSAGES_UPLOAD_DIR = join(process.cwd(), 'uploads', 'messages');

@Controller('messages')
export class MessagesController {
  constructor(private readonly messagesService: MessagesService) {}

  /** Inbox: every contract the user participates in + last message + unread count. */
  @Get('inbox')
  @UseGuards(JwtAuthGuard, TelegramGuard)
  async getInbox(@Req() req: any) {
    return this.messagesService.getInbox(req.user);
  }

  /** Sum of unread across all of the user's contracts (for a global badge). */
  @Get('inbox/unread-count')
  @UseGuards(JwtAuthGuard, TelegramGuard)
  async getTotalUnread(@Req() req: any) {
    return { total: await this.messagesService.getTotalUnread(req.user) };
  }

  @Get('contract/:id')
  @UseGuards(JwtAuthGuard, TelegramGuard)
  async getByContract(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.messagesService.findByContract(id, req.user?.userId);
  }

  /** Mark all messages in this contract as read for the current user. */
  @Post('contract/:id/read')
  @UseGuards(JwtAuthGuard, TelegramGuard)
  async markRead(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.messagesService.markRead(req.user.userId, id);
  }

  /** Upload a single file (image or PDF) for a chat. Returns a URL to be
   *  passed back into sendMessage as fileUrl. */
  @Post('upload')
  @UseGuards(JwtAuthGuard, TelegramGuard)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: MESSAGES_UPLOAD_DIR,
        filename: (_req, file, cb) => {
          const unique =
            Date.now().toString(36) +
            '-' +
            Math.random().toString(36).slice(2, 10);
          cb(null, `${unique}${extname(file.originalname).toLowerCase()}`);
        },
      }),
      limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
      fileFilter: (_req, file, cb) => {
        const ok =
          /^image\/(png|jpe?g|gif|webp|heic)$/i.test(file.mimetype) ||
          file.mimetype === 'application/pdf';
        if (!ok) return cb(new BadRequestException('Faqat rasm yoki PDF ruxsat etilgan'), false);
        cb(null, true);
      },
    }),
  )
  uploadFile(@UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException("Fayl yuklanmadi");
    return {
      url: `/api/messages/file/${file.filename}`,
      fileName: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
    };
  }

  /** Stream a previously uploaded chat file. (Auth via JwtAuthGuard.) */
  @Get('file/:fname')
  serveFile(@Param('fname') fname: string, @Res() res: Response) {
    // basic traversal guard
    if (fname.includes('/') || fname.includes('..')) {
      throw new BadRequestException('Fayl nomi noto‘g‘ri');
    }
    const fp = join(MESSAGES_UPLOAD_DIR, fname);
    if (!existsSync(fp)) {
      res.status(404).json({ message: 'Fayl topilmadi' });
      return;
    }
    res.sendFile(fp);
  }
}
