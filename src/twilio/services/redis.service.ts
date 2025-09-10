import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient } from 'redis';
import * as stringSimilarity from 'string-similarity';
import * as fs from 'fs';
import * as path from 'path';
import * as glob from 'glob';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private isConnected = false;
  private redisClient;
  private readonly SIMILARITY_THRESHOLD = 0.8;
  private readonly assistantType: string;

  constructor(private readonly configService: ConfigService) {
    const redisUrl = this.configService.get<string>('REDIS_URL');
    this.assistantType = this.configService.get<string>('ASSISTANT_TYPE') || 'general';

    if (!redisUrl) {
      this.logger.error('Redis URL not configured. Please set REDIS_URL environment variable or check redis.config.ts');
    }
    this.redisClient = createClient({
      url: redisUrl || 'redis://localhost:6379',
    });

    this.redisClient.on('error', (err) => this.logger.error('Redis Client Error', err));
    this.redisClient.on('connect', () => {
      this.logger.verbose('Connected to Redis successfully.');
      this.isConnected = true;
    });
    this.redisClient.on('reconnecting', () => this.logger.log('Reconnecting to Redis...'));
    this.redisClient.on('end', () => {
      this.logger.log('Redis connection closed.');
      this.isConnected = false;
    });
  }

  async onModuleInit() {
    try {
      await this.redisClient.connect();
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (this.isConnected) {
        await this.populateAllAssistantTypes();
      } else {
        this.logger.error('Could not connect to Redis. Q&A population skipped.');
      }
    } catch (err) {
      this.logger.error('Failed to connect to Redis on module init:', err);
    }
  }

  async onModuleDestroy() {
    if (this.redisClient && this.isConnected) {
      await this.redisClient.quit();
      this.logger.log('Redis client disconnected.');
    }
  }

  /**
   * Loads Q&A data for all assistant types into Redis using key prefixes.
   */
  private async populateAllAssistantTypes() {
    const assistantDirs = glob.sync('src/twilio/assistant/*/data.json');
    for (const dataPath of assistantDirs) {
      const assistantType = dataPath.split('/')[3]; // e.g., 'speedel', 'hospital'
      try {
        const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
        for (const qa of data) {
          if (qa.question && qa.answer) {
            const key = `${assistantType}:question:${qa.question}`;
            await this.redisClient.set(key, qa.answer);
          }
        }
        this.logger.verbose(`Loaded ${data.length} Q&A pairs for assistant type: ${assistantType}`);
      } catch (error) {
        this.logger.error(`Error loading data for assistant type: ${assistantType}`, error);
      }
    }
  }

  /**
   * Searches for an answer in Redis for the given assistant type and user question.
   */
  public async getAnswerFromRedis(userQuestion: string, assistantType: string): Promise<string | null> {
    if (!this.isConnected) {
      this.logger.warn('Cannot get answer from Redis: Not connected.');
      return null;
    }

    try {
      const prefix = `${assistantType}:question:*`;
      const keys = await this.redisClient.keys(prefix);
      if (!keys || keys.length === 0) {
        this.logger.verbose(`
          ❌ No questions found in Redis cache for assistant type: ${assistantType}.
          `);
        return null;
      }

      let bestMatchKey: string | null = null;
      let bestMatchScore = 0;
      const normalizedUserQuestion = userQuestion.toLowerCase().trim();

      for (const key of keys) {
        const question = key.split(':question:')[1];
        const normalizedKey = question.toLowerCase().trim();
        const similarity = stringSimilarity.compareTwoStrings(normalizedUserQuestion, normalizedKey);
        if (similarity > bestMatchScore) {
          bestMatchScore = similarity;
          bestMatchKey = key;
        }
      }

      if (bestMatchKey && bestMatchScore >= this.SIMILARITY_THRESHOLD) {
        const cachedResponse = await this.redisClient.get(bestMatchKey);
        if (cachedResponse) {
          this.logger.verbose(`
        ✅ Found in Redis with score: ${bestMatchScore.toFixed(2)}
           Question : "${userQuestion}"
           Answer   : "${cachedResponse}"
          `);
          return cachedResponse;
        }
      }
      this.logger.verbose(`
        ❌ Not found in Redis. Score: ${bestMatchScore.toFixed(2)}
        `);
      return null;
    } catch (error) {
      this.logger.error('Error retrieving answer from Redis:', error);
      return null;
    }
  }
}
