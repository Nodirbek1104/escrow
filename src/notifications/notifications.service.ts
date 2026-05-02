import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Notification } from './entities/notification.entity';

@Injectable()
export class NotificationsService {
  constructor(
    @InjectRepository(Notification)
    private readonly notificationRepo: Repository<Notification>,
  ) {}

  async create(userId: number, title: string, message: string, type?: string, relatedId?: string) {
    const notification = this.notificationRepo.create({
      userId,
      title,
      message,
      type,
      relatedId,
    });
    return this.notificationRepo.save(notification);
  }

  async findAll(userId: number) {
    return this.notificationRepo.find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });
  }

  async getUnreadCount(userId: number) {
    return this.notificationRepo.count({
      where: { userId, isRead: false },
    });
  }

  async markAsRead(id: number, userId: number) {
    return this.notificationRepo.update({ id, userId }, { isRead: true });
  }

  async markAllAsRead(userId: number) {
    return this.notificationRepo.update({ userId }, { isRead: true });
  }
}
