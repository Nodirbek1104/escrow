import {
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
  ParseIntPipe,
} from '@nestjs/common';
import { MessagesService } from './messages.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TelegramGuard } from '../auth/guards/telegram.guard';

@Controller('messages')
@UseGuards(JwtAuthGuard, TelegramGuard)
export class MessagesController {
  constructor(private readonly messagesService: MessagesService) {}

  /** Inbox: every contract the user participates in + last message + unread count. */
  @Get('inbox')
  async getInbox(@Req() req: any) {
    return this.messagesService.getInbox(req.user);
  }

  /** Sum of unread across all of the user's contracts (for a global badge). */
  @Get('inbox/unread-count')
  async getTotalUnread(@Req() req: any) {
    return { total: await this.messagesService.getTotalUnread(req.user) };
  }

  @Get('contract/:id')
  async getByContract(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.messagesService.findByContract(id, req.user?.userId);
  }

  /** Mark all messages in this contract as read for the current user. */
  @Post('contract/:id/read')
  async markRead(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.messagesService.markRead(req.user.userId, id);
  }
}
