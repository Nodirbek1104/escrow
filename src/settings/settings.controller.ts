import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { SettingsService } from './settings.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdminGuard } from '../auth/guards/admin.guard';

@Controller('admin/settings')
@UseGuards(JwtAuthGuard, AdminGuard)
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  list() {
    return this.settings.getAll();
  }

  @Patch(':key')
  async update(
    @Param('key') key: string,
    @Body() body: { value?: string; description?: string },
  ) {
    if (typeof body?.value !== 'string') {
      throw new BadRequestException('value matn bo\'lishi kerak');
    }
    return this.settings.set(key, body.value, body.description);
  }
}
