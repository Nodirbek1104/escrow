import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, MoreThan, Not, Repository } from 'typeorm';
import { Message } from './entities/message.entity';
import { ChatRead } from './entities/chat-read.entity';
import { EscrowContract } from '../escrocontracts/entities/escrocontract.entity';

export interface InboxUser {
  userId: number;
  phoneNumber?: string;
  role?: string;
}

@Injectable()
export class MessagesService {
  constructor(
    @InjectRepository(Message)
    private readonly messageRepository: Repository<Message>,
    @InjectRepository(ChatRead)
    private readonly chatReadRepository: Repository<ChatRead>,
    @InjectRepository(EscrowContract)
    private readonly contractRepository: Repository<EscrowContract>,
  ) {}

  async create(
    contractId: number,
    content: string,
    senderId: number,
    fileUrl?: string,
  ) {
    const message = this.messageRepository.create({
      contractId,
      content,
      senderId,
      fileUrl,
      type: 'user',
    });
    return this.messageRepository.save(message);
  }

  /** Persist a system note in a contract chat (status change, etc.) */
  async createSystem(
    contractId: number,
    content: string,
    payload?: Record<string, any>,
  ) {
    const message = this.messageRepository.create({
      contractId,
      content,
      senderId: 0,
      type: 'system',
      systemPayload: payload ?? null,
    });
    return this.messageRepository.save(message);
  }

  async findByContract(contractId: number, userId?: number) {
    const messages = await this.messageRepository.find({
      where: { contractId },
      order: { createdAt: 'ASC' },
      relations: ['sender'],
    });

    // Annotate each message with readByOther for the ✓ / ✓✓ ticks UI.
    // For 2-party contracts (creator + executor), "other party's lastReadAt"
    // suffices; we read every party's pointer except the requester's.
    const otherReads = await this.chatReadRepository.find({
      where: { contractId },
    });
    const othersExcludingMe = otherReads.filter((r) => r.userId !== userId);
    const otherLastReadAt = othersExcludingMe.length
      ? othersExcludingMe.reduce(
          (acc, r) => (r.lastReadAt > acc ? r.lastReadAt : acc),
          new Date(0),
        )
      : null;

    return messages.map((m) => ({
      ...m,
      readByOther: otherLastReadAt
        ? new Date(m.createdAt) <= otherLastReadAt
        : false,
    }));
  }

  /** Per-user inbox: every contract the user participates in, with the
   *  last message and an unread count. Sorted by last activity. */
  async getInbox(user: InboxUser) {
    const phoneDigits = (user.phoneNumber ?? '').replace(/\D/g, '');

    // Find all contracts the user is part of (creator, linked executor, or
    // invited via phone number even if they haven't accepted yet).
    const contracts = await this.contractRepository.find({
      where: [
        { creatorId: user.userId },
        ...(user.userId ? [{ executorId: user.userId }] : []),
        ...(phoneDigits ? [{ executorPhoneNumber: `+998${phoneDigits.startsWith('998') ? phoneDigits.slice(3) : phoneDigits}` }] : []),
      ],
      relations: ['creator'],
    });

    if (contracts.length === 0) return [];

    const ids = contracts.map((c) => c.id);

    // Pull the per-user read pointers in one round-trip.
    const reads = await this.chatReadRepository.find({
      where: { userId: user.userId, contractId: In(ids) },
    });
    const readByContract = new Map<number, Date>();
    for (const r of reads) readByContract.set(r.contractId, r.lastReadAt);

    // For each contract: (last message, unread count) — small N (typical
    // user has dozens, not thousands), parallelisable.
    const rows = await Promise.all(
      contracts.map(async (c) => {
        const lastReadAt = readByContract.get(c.id) ?? new Date(0);
        const [lastMsg, unreadCount] = await Promise.all([
          this.messageRepository.findOne({
            where: { contractId: c.id },
            order: { createdAt: 'DESC' },
            relations: ['sender'],
          }),
          this.messageRepository.count({
            where: {
              contractId: c.id,
              senderId: Not(user.userId),
              createdAt: MoreThan(lastReadAt),
            },
          }),
        ]);

        return {
          contractId: c.id,
          title: c.title,
          status: c.status,
          amount: Number(c.amount ?? 0),
          creator: c.creator
            ? {
                id: c.creator.id,
                fullName: c.creator.fullName,
                phoneNumber: c.creator.phoneNumber,
              }
            : null,
          executorPhoneNumber: c.executorPhoneNumber,
          executorId: c.executorId ?? null,
          lastMessage: lastMsg
            ? {
                id: lastMsg.id,
                content: lastMsg.content,
                createdAt: lastMsg.createdAt,
                senderId: lastMsg.senderId,
                senderName: lastMsg.sender?.fullName ?? null,
                fileUrl: lastMsg.fileUrl ?? null,
              }
            : null,
          lastActivityAt: lastMsg?.createdAt ?? c.createdAt,
          unreadCount,
        };
      }),
    );

    rows.sort(
      (a, b) =>
        new Date(b.lastActivityAt).getTime() -
        new Date(a.lastActivityAt).getTime(),
    );

    return rows;
  }

  /** Mark all messages in a contract as read for the given user.
   *  Idempotent: upserts the chat_reads row to NOW(). */
  async markRead(userId: number, contractId: number) {
    let read = await this.chatReadRepository.findOne({
      where: { userId, contractId },
    });
    if (!read) {
      read = this.chatReadRepository.create({
        userId,
        contractId,
        lastReadAt: new Date(),
      });
    } else {
      read.lastReadAt = new Date();
    }
    await this.chatReadRepository.save(read);
    return { ok: true, lastReadAt: read.lastReadAt };
  }

  /** Sum of unread across all the user's contracts — for a global badge. */
  async getTotalUnread(user: InboxUser): Promise<number> {
    const inbox = await this.getInbox(user);
    return inbox.reduce((sum, row) => sum + row.unreadCount, 0);
  }
}
