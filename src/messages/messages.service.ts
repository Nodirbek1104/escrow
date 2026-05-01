import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Message } from './entities/message.entity';
import { User } from '../user/entities/user.entity';

@Injectable()
export class MessagesService {
  constructor(
    @InjectRepository(Message)
    private readonly messageRepository: Repository<Message>,
  ) {}

  async create(contractId: number, content: string, senderId: number, fileUrl?: string) {
    const message = this.messageRepository.create({
      contractId,
      content,
      senderId,
      fileUrl,
    });
    return this.messageRepository.save(message);
  }

  async findByContract(contractId: number) {
    return this.messageRepository.find({
      where: { contractId },
      order: { createdAt: 'ASC' },
      relations: ['sender'],
    });
  }
}
