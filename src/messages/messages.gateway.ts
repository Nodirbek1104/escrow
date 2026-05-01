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
