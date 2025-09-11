import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import redisConfig from '../config/redis.config';
import { ChromaController } from './controllers/chroma.controller';
import { ConversationLogController } from './controllers/conversation-log.controller';
import { EmbeddingController } from './controllers/embedding.controller';
import { QdrantController } from './controllers/qdrant.controller';
import { TwilioController } from './controllers/twilio.controller';
import { TwilioGateway } from './gateway/twilio.gateway';
import { ChatGateway } from './gateway/chat.gateway';
import { AIResponseService } from './services/ai-response.service';
import { AudioProcessingService } from './services/audio-processing.service';
import { BookingFlowService } from './services/booking-flow.service';
import { BookingSessionService } from './services/booking-session.service';
import { ChromaDBService } from './services/chroma-db.services';
import { ConversationLoggerService } from './services/conversation-logger.service';
import { DirectAIService } from './services/direct-ai.service';
import { ElevenLabsService } from './services/elevenlabs.service';
import { EmailService } from './services/email.service';
import { EmbeddingService } from './services/embedding.service';
import { GoogleCloudService } from './services/google-cloud.service';
import { OpenAIAssistantService } from './services/open-ai-assistant.service';
import { OpenAIBookingAssistantService } from './services/openai-booking-assistant.service';
import { QdrantDBService } from './services/qdrant-db.services';
import { RedisService } from './services/redis.service';
import { SpeechService } from './services/speech.service';
import { TwilioApiService } from './services/twilio-api.service';
import { WhisperService } from './services/whisper.service';
import { WordCorrectionService } from './services/word-correction.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      load: [redisConfig],
      isGlobal: false,
    }),
  ],
  controllers: [TwilioController, ChromaController, QdrantController, ConversationLogController, EmbeddingController],
  providers: [
    TwilioGateway,
    ChatGateway,
    WhisperService,
    ElevenLabsService,
    AudioProcessingService,
    AIResponseService,
    TwilioApiService,
    OpenAIAssistantService,
    OpenAIBookingAssistantService,
    RedisService,
    WordCorrectionService,
    ChromaDBService,
    QdrantDBService,
    ConversationLoggerService,
    DirectAIService,
    EmailService,
    EmbeddingService,
    GoogleCloudService,
    SpeechService,
    BookingSessionService,
    BookingFlowService,
  ],
  exports: [RedisService, ChromaDBService, QdrantDBService, ConversationLoggerService, EmailService, SpeechService],
})
export class TwilioModule {}
