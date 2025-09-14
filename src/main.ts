import { ConsoleLogger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import * as http from 'http';
import { Server } from 'socket.io';
import { AppModule } from './app/app.module';
import { CustomLogger } from './common/logger/custom-logger.service';
import { ChatGateway } from './twilio/gateway/chat.gateway';

async function bootstrap() {
  const startTime = Date.now();
  const logger = new CustomLogger('Main');
  
  console.log('🚀 Starting application...');
  
  const app = await NestFactory.create(AppModule, {
    // logger: new MyCustomLogger(),
    logger: new ConsoleLogger({
      logLevels: ['log', 'error', 'warn', 'debug', 'verbose', 'fatal'],
      prefix: '🚀',
      timestamp: false, // Default is "Nest"
    }),
  });

  app.useWebSocketAdapter(new WsAdapter(app));
  app.enableCors(); // Enable CORS for all origins by default

  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT') || 3001;
  await app.listen(port, '0.0.0.0');

  // Create separate HTTP server for Socket.IO on port 3002
  const socketServer = http.createServer();
  const io = new Server(socketServer, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
      credentials: true,
    },
  });

  // Get ChatGateway from NestJS container and initialize handlers
  const chatGateway = app.get(ChatGateway);
  chatGateway.initialize(io);

  // Start Socket.IO server on port 3002
  const socketPort = 3002;
  socketServer.listen(socketPort, '0.0.0.0', () => {
    console.log(`🚀 Socket.IO server is running on port ${socketPort}`);
  });

  const startupTime = Date.now() - startTime;
  console.log(`🚀 Main server is running on port ${port} (startup: ${startupTime}ms)`);
}
bootstrap();
