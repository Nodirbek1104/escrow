import {
  WebSocketGateway,
  SubscribeMessage,
  MessageBody,
  WebSocketServer,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { MessagesService } from './messages.service';
import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';

@WebSocketGateway({
  cors: {
    origin: '*',
  },
  // Mount under /api/socket.io/ so that the existing nginx `/api` proxy
  // (with proxy_set_header Upgrade) carries WebSocket frames to backend
  // without us needing a separate `/socket.io` location block.
  path: '/api/socket.io/',
})
export class MessagesGateway {
  @WebSocketServer()
  server: Server;

  constructor(
    private readonly messagesService: MessagesService,
    private readonly jwtService: JwtService,
  ) {}

  async handleConnection(client: Socket) {
    try {
      const token = client.handshake.auth.token || client.handshake.headers.token;
      if (!token) throw new UnauthorizedException();
      
      const payload = this.jwtService.verify(token);
      client.data.user = payload;
      
      // Join room for the user to receive private notifications or join contract rooms later
      this.server.to(client.id).emit('connected', { userId: payload.sub });
    } catch (e) {
      client.disconnect();
    }
  }

  @SubscribeMessage('joinContract')
  handleJoinContract(
    @MessageBody() data: { contractId: number },
    @ConnectedSocket() client: Socket,
  ) {
    client.join(`contract_${data.contractId}`);
    return { status: 'joined', room: `contract_${data.contractId}` };
  }

  /**
   * Broadcast a generic event to everyone currently in the contract room.
   * Used by EscrocontractsService to push status changes (contractUpdated)
   * so the FE doesn't have to poll.
   */
  emitToContract(contractId: number, event: string, payload: any) {
    if (!this.server) return;
    this.server.to(`contract_${contractId}`).emit(event, payload);
  }

  /** Broadcast a typing indicator to everyone in the contract room except
   *  the sender. Frontend debounces emits client-side. */
  @SubscribeMessage('typing')
  handleTyping(
    @MessageBody() data: { contractId: number },
    @ConnectedSocket() client: Socket,
  ) {
    const user = client.data.user;
    if (!user || !data?.contractId) return;
    client.to(`contract_${data.contractId}`).emit('userTyping', {
      contractId: data.contractId,
      userId: user.sub,
      fullName: user.fullName,
      at: Date.now(),
    });
  }

  @SubscribeMessage('sendMessage')
  async handleMessage(
    @MessageBody() data: { contractId: number; content: string; fileUrl?: string },
    @ConnectedSocket() client: Socket,
  ) {
    const user = client.data.user;
    if (!user) return;

    const savedMessage = await this.messagesService.create(
      data.contractId,
      data.content,
      user.sub,
      data.fileUrl,
    );

    // Broadcast to all users in the contract room
    this.server.to(`contract_${data.contractId}`).emit('newMessage', {
      ...savedMessage,
      sender: {
        id: user.sub,
        fullName: user.fullName || 'User',
      },
    });

    return savedMessage;
  }
}
