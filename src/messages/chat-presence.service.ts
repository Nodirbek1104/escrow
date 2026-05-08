import { Injectable } from '@nestjs/common';

/**
 * Process-local presence map for chat sockets.
 * Tracks `userId → Set<socketId>` so the message service can ask
 * "is user N currently connected?" before deciding whether to fire a
 * Telegram push notification.
 */
@Injectable()
export class ChatPresenceService {
  private readonly sockets = new Map<number, Set<string>>();

  add(userId: number, socketId: string) {
    if (!userId) return;
    let set = this.sockets.get(userId);
    if (!set) {
      set = new Set();
      this.sockets.set(userId, set);
    }
    set.add(socketId);
  }

  remove(userId: number, socketId: string) {
    if (!userId) return;
    const set = this.sockets.get(userId);
    if (!set) return;
    set.delete(socketId);
    if (set.size === 0) this.sockets.delete(userId);
  }

  isOnline(userId: number): boolean {
    return (this.sockets.get(userId)?.size ?? 0) > 0;
  }
}
