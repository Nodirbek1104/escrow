import { Controller, Get, Param, UseGuards, ParseIntPipe, Req } from '@nestjs/common';
import { MessagesService } from './messages.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TelegramGuard } from '../auth/guards/telegram.guard';

@Controller('messages')
@UseGuards(JwtAuthGuard, TelegramGuard)
export class MessagesController {
  constructor(private readonly messagesService: MessagesService) {}

  @Get('contract/:id')
  async getByContract(@Param('id', ParseIntPipe) id: number) {
    return this.messagesService.findByContract(id);
  }
}
