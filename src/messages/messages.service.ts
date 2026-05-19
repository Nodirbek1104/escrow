import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, MoreThan, Not, Repository } from 'typeorm';
import axios from 'axios';
import { Message } from './entities/message.entity';
import { ChatRead } from './entities/chat-read.entity';
import { EscrowContract } from '../escrocontracts/entities/escrocontract.entity';
import { User } from '../user/entities/user.entity';
import { ChatPresenceService } from './chat-presence.service';

export interface InboxUser {
  userId: number;
  phoneNumber?: string;
  role?: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

@Injectable()
export class MessagesService {
  private readonly logger = new Logger(MessagesService.name);

  constructor(
    @InjectRepository(Message)
    private readonly messageRepository: Repository<Message>,
    @InjectRepository(ChatRead)
    private readonly chatReadRepository: Repository<ChatRead>,
    @InjectRepository(EscrowContract)
    private readonly contractRepository: Repository<EscrowContract>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly presence: ChatPresenceService,
  ) {}

  /**
   * After a chat message is broadcast over the socket, send a Telegram bot
   * push to every recipient who is *not currently online*. Sender is skipped;
   * users without a linked telegramId are skipped silently. This is fire-and-
   * forget — we don't await it from the caller's hot path.
   */
  async pushNotifyOfflineRecipients(
    contractId: number,
    senderId: number,
    payload: { content?: string; fileUrl?: string; senderName?: string; type?: string },
  ): Promise<void> {
    if (payload.type === 'system') return;
    const botToken = process.env.TG_BOT_TOKEN;
    if (!botToken) return;

    const contract = await this.contractRepository.findOne({
      where: { id: contractId },
    });
    if (!contract) return;

    const candidates = [contract.creatorId, contract.executorId].filter(
      (uid): uid is number => typeof uid === 'number' && uid > 0 && uid !== senderId,
    );
    if (candidates.length === 0) return;

    const users = await this.userRepository.find({ where: { id: In(candidates) } });
    const offlineWithTg = users.filter(
      (u) => u?.telegramId && !this.presence.isOnline(u.id),
    );
    if (offlineWithTg.length === 0) return;

    const frontend = process.env.FRONTEND_URL ?? 'https://aws-dev.escro.uz';
    const preview = payload.fileUrl
      ? '📎 Fayl'
      : (payload.content ?? '').slice(0, 200);
    const senderLabel = payload.senderName || 'Yangi xabar';
    const text =
      `<b>${escapeHtml(senderLabel)}</b>\n` +
      `${escapeHtml(preview)}\n\n` +
      `<a href="${frontend}/app/contracts/${contractId}">Ochish</a>`;

    await Promise.all(
      offlineWithTg.map(async (u) => {
        try {
          await axios.post(
            `https://api.telegram.org/bot${botToken}/sendMessage`,
            {
              chat_id: u.telegramId,
              text,
              parse_mode: 'HTML',
              disable_web_page_preview: true,
            },
            { timeout: 8_000 },
          );
        } catch (err: any) {
          this.logger.warn(
            `TG push fail for user ${u.id}: ${err?.response?.data?.description ?? err?.message}`,
          );
        }
      }),
    );
  }

  async create(
    contractId: number,
    content: string,
    senderId: number,
    fileUrl?: string,
    replyToId?: number,
  ) {
    const message = this.messageRepository.create({
      contractId,
      content,
      senderId,
      fileUrl,
      type: 'user',
      replyToId: replyToId ?? null,
    });
    const saved = await this.messageRepository.save(message);
    // Re-fetch with replyTo so the broadcast carries the quoted snippet.
    return this.messageRepository.findOne({
      where: { id: saved.id },
      relations: ['sender', 'replyTo', 'replyTo.sender'],
    }) as Promise<Message>;
  }

  /**
   * Forward an existing message into a different contract chat. The caller
   * must participate in BOTH the source (to read the original) and the
   * target (to send into it). The forwarded copy carries a frozen snapshot
   * of the source so we can render "Forwarded from X" even after edits.
   */
  async forwardMessage(args: {
    sourceMessageId: number;
    targetContractId: number;
    user: InboxUser;
  }) {
    const source = await this.messageRepository.findOne({
      where: { id: args.sourceMessageId },
      relations: ['sender'],
    });
    if (!source) throw new NotFoundException('Xabar topilmadi');
    if (source.deletedAt) {
      throw new BadRequestException("O'chirilgan xabarni forward qilib bo'lmaydi");
    }
    if (source.type !== 'user') {
      throw new BadRequestException('Tizim xabarini forward qilib bo\'lmaydi');
    }

    const [sourceContract, targetContract] = await Promise.all([
      this.contractRepository.findOne({ where: { id: source.contractId } }),
      this.contractRepository.findOne({ where: { id: args.targetContractId } }),
    ]);
    if (!sourceContract || !targetContract) {
      throw new NotFoundException('Shartnoma topilmadi');
    }
    this.assertContractParticipant(sourceContract, args.user);
    this.assertContractParticipant(targetContract, args.user);

    const forwarded = this.messageRepository.create({
      contractId: args.targetContractId,
      content: source.content,
      fileUrl: source.fileUrl,
      senderId: args.user.userId,
      type: 'user',
      forwardedFrom: {
        originalMessageId: source.id,
        sourceContractId: source.contractId,
        sourceContractTitle: sourceContract.title ?? null,
        senderId: source.senderId,
        senderName: source.sender?.fullName ?? null,
      },
    });
    const saved = await this.messageRepository.save(forwarded);
    return this.messageRepository.findOne({
      where: { id: saved.id },
      relations: ['sender'],
    }) as Promise<Message>;
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
      senderId: null,
      type: 'system',
      systemPayload: payload ?? null,
    });
    return this.messageRepository.save(message);
  }

  /**
   * Cursor-based pagination. Default behaviour (no `before`) returns the
   * most recent `limit` messages in chronological order — i.e. the page
   * a user sees on first open. `before` clamps to messages strictly older
   * than the given id so the FE can prepend earlier history on scroll-up.
   *
   * `hasMore` is true when at least one message exists older than the
   * earliest in the returned page; the FE uses this to stop polling.
   */
  async findByContract(
    contractId: number,
    userId?: number,
    opts?: { before?: number; limit?: number },
  ) {
    const limit = Math.max(1, Math.min(opts?.limit ?? 50, 100));
    const before = opts?.before;

    const whereClause: Record<string, any> = { contractId };
    if (before && before > 0) {
      whereClause.id = LessThan(before);
    }

    // Fetch newest-first then reverse so the FE keeps its
    // chronological-ascending render order.
    const newestFirst = await this.messageRepository.find({
      where: whereClause,
      order: { id: 'DESC' },
      take: limit,
      relations: ['sender', 'replyTo', 'replyTo.sender'],
    });
    const messages = newestFirst.slice().reverse();

    // Does anything exist older than the earliest one we returned?
    let hasMore = false;
    if (messages.length === limit) {
      const oldestId = messages[0]?.id;
      if (oldestId) {
        const older = await this.messageRepository.count({
          where: { contractId, id: LessThan(oldestId) },
        });
        hasMore = older > 0;
      }
    }

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

    return {
      messages: messages.map((m) => ({
        ...m,
        readByOther: otherLastReadAt
          ? new Date(m.createdAt) <= otherLastReadAt
          : false,
      })),
      hasMore,
      oldestId: messages[0]?.id ?? null,
    };
  }

  /**
   * Per-user inbox. Default view hides archived chats; pass
   * `{ archivedOnly: true }` to see only the archive bin. Sorted by
   * last activity descending either way.
   */
  async getInbox(user: InboxUser, opts?: { archivedOnly?: boolean }) {
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
    const archivedByContract = new Map<number, Date>();
    for (const r of reads) {
      readByContract.set(r.contractId, r.lastReadAt);
      if (r.archivedAt) archivedByContract.set(r.contractId, r.archivedAt);
    }
    const archivedOnly = !!opts?.archivedOnly;

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
          archivedAt: archivedByContract.get(c.id) ?? null,
        };
      }),
    );

    // Auto-unarchive: if a new message arrived after the user archived,
    // surface the chat again. Otherwise filter to match the requested view.
    const filtered = rows.filter((r) => {
      if (!r.archivedAt) return !archivedOnly;
      const stillArchived =
        new Date(r.lastActivityAt) <= new Date(r.archivedAt);
      return archivedOnly ? stillArchived : !stillArchived;
    });

    filtered.sort(
      (a, b) =>
        new Date(b.lastActivityAt).getTime() -
        new Date(a.lastActivityAt).getTime(),
    );

    return filtered;
  }

  /** Pin a message in the contract chat. Any participant or admin may pin. */
  async pinMessage(
    contractId: number,
    messageId: number,
    user: { userId: number; phoneNumber?: string; role?: string },
  ) {
    const contract = await this.contractRepository.findOne({
      where: { id: contractId },
    });
    if (!contract) throw new NotFoundException('Shartnoma topilmadi');
    this.assertContractParticipant(contract, user);

    const m = await this.messageRepository.findOne({
      where: { id: messageId },
    });
    if (!m || m.contractId !== contractId) {
      throw new NotFoundException('Xabar topilmadi');
    }
    if (m.deletedAt) {
      throw new BadRequestException("O'chirilgan xabarni qatirib bo'lmaydi");
    }

    contract.pinnedMessageId = messageId;
    await this.contractRepository.save(contract);
    return { ok: true, pinnedMessageId: messageId };
  }

  async unpinMessage(
    contractId: number,
    user: { userId: number; phoneNumber?: string; role?: string },
  ) {
    const contract = await this.contractRepository.findOne({
      where: { id: contractId },
    });
    if (!contract) throw new NotFoundException('Shartnoma topilmadi');
    this.assertContractParticipant(contract, user);

    contract.pinnedMessageId = null;
    await this.contractRepository.save(contract);
    return { ok: true };
  }

  private assertContractParticipant(
    contract: EscrowContract,
    user: { userId: number; phoneNumber?: string; role?: string },
  ) {
    const isAdmin = user.role === 'admin' || user.role === 'super_admin';
    if (isAdmin) return;
    const phoneDigits = (user.phoneNumber ?? '').replace(/\D/g, '');
    const inviteeDigits = String(contract.executorPhoneNumber ?? '').replace(/\D/g, '');
    const isCreator = contract.creatorId === user.userId;
    const isExecutor =
      contract.executorId === user.userId ||
      (phoneDigits && phoneDigits === inviteeDigits);
    if (!isCreator && !isExecutor) {
      // IDOR-safe: opaque 404 — listing chat for a non-participant must
      // not confirm whether the contract id exists.
      throw new NotFoundException('Shartnoma topilmadi');
    }
  }

  /** Edit own user message. Cannot edit system or deleted messages. */
  async editMessage(messageId: number, userId: number, newContent: string) {
    const m = await this.messageRepository.findOne({
      where: { id: messageId },
    });
    if (!m) throw new NotFoundException('Xabar topilmadi');
    if (m.senderId !== userId) {
      throw new ForbiddenException('Faqat o\'z xabaringizni tahrirlay olasiz');
    }
    if (m.type === 'system') {
      throw new BadRequestException('Tizim xabarini tahrirlab bo\'lmaydi');
    }
    if (m.deletedAt) {
      throw new BadRequestException('O\'chirilgan xabarni tahrirlab bo\'lmaydi');
    }
    if (!newContent || !newContent.trim()) {
      throw new BadRequestException('Matn bo\'sh bo\'lmasligi kerak');
    }
    m.content = newContent.trim();
    m.editedAt = new Date();
    return this.messageRepository.save(m);
  }

  /** Soft-delete own user message. Row stays for audit; content cleared. */
  async deleteMessage(messageId: number, userId: number) {
    const m = await this.messageRepository.findOne({
      where: { id: messageId },
    });
    if (!m) throw new NotFoundException('Xabar topilmadi');
    if (m.senderId !== userId) {
      throw new ForbiddenException("Faqat o'z xabaringizni o'chira olasiz");
    }
    if (m.type === 'system') {
      throw new BadRequestException("Tizim xabarini o'chirib bo'lmaydi");
    }
    if (m.deletedAt) return m; // idempotent
    m.deletedAt = new Date();
    m.content = '';
    m.fileUrl = null as any;
    return this.messageRepository.save(m);
  }

  /**
   * Toggle the per-user archive flag on a contract chat. Idempotent on the
   * upsert path. Returns the new state so the FE can update its view
   * without a refetch.
   */
  async setArchived(userId: number, contractId: number, archived: boolean) {
    let read = await this.chatReadRepository.findOne({
      where: { userId, contractId },
    });
    if (!read) {
      read = this.chatReadRepository.create({
        userId,
        contractId,
        lastReadAt: new Date(),
      });
    }
    read.archivedAt = archived ? new Date() : null;
    await this.chatReadRepository.save(read);
    return { ok: true, archived: !!read.archivedAt };
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
