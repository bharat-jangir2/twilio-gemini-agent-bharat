import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';
import { GoogleGenerativeAI } from '@google/generative-ai';
import * as path from 'path';
import { ConversationLoggerService } from './conversation-logger.service';

// AI Provider interface for abstraction
interface AIProvider {
  invoke(prompt: string): Promise<{ content: string }>;
}

// OpenAI Provider implementation
class OpenAIProvider implements AIProvider {
  private model: ChatOpenAI;

  constructor(apiKey: string) {
    this.model = new ChatOpenAI({
      openAIApiKey: apiKey,
      modelName: process.env.OPENAI_MODEL as string,
      temperature: 0.7,
    });
  }

  async invoke(prompt: string): Promise<{ content: string }> {
    const response = await this.model.invoke(prompt);
    return { content: response.content as string };
  }
}

// Google Gemini Provider implementation
class GoogleGeminiProvider implements AIProvider {
  private model: any;

  constructor(apiKey: string) {
    const genAI = new GoogleGenerativeAI(apiKey);
    this.model = genAI.getGenerativeModel({ model: process.env.GOOGLE_AI_MODEL as string });
  }

  async invoke(prompt: string): Promise<{ content: string }> {
    const result = await this.model.generateContent(prompt);
    const response = await result.response;
    return { content: response.text() };
  }
}

@Injectable()
export class DirectAIService {
  private readonly logger = new Logger(DirectAIService.name);
  private readonly aiProvider: AIProvider;

  constructor(
    private readonly configService: ConfigService,
    private readonly conversationLogger: ConversationLoggerService,
  ) {
    // Initialize AI Provider based on environment variable
    const aiProvider = this.configService.get('AI_PROVIDER') || 'GOOGLE';
    const openaiApiKey = this.configService.get('OPENAI_API_KEY');
    const geminiApiKey = this.configService.get('GOOGLE_API_KEY');

    if (aiProvider === 'OPENAI') {
      if (!openaiApiKey) {
        throw new Error('OPENAI_API_KEY is required when AI_PROVIDER is set to openai');
      }
      this.aiProvider = new OpenAIProvider(openaiApiKey);
      this.logger.log(`Initialized OpenAI provider (${process.env.OPENAI_MODEL})`);
    } else {
      // Default to Google (Gemini)
      if (!geminiApiKey) {
        throw new Error('GOOGLE_API_KEY is required for Google Gemini provider');
      }
      this.aiProvider = new GoogleGeminiProvider(geminiApiKey);
      this.logger.log(`Initialized Google Gemini provider (${process.env.GOOGLE_AI_MODEL})`);
    }
  }

  // Generate direct AI response without database lookup
  async getDirectAIResponse(question: string, assistantType: string = 'general', sessionId?: string): Promise<string> {
    try {
      this.logger.log(`🔍 [DIRECT AI] Starting response generation for session: ${sessionId}`);
      this.logger.log(`🔍 [DIRECT AI] Question: "${question}"`);
      this.logger.log(`🔍 [DIRECT AI] Assistant Type: ${assistantType}`);

      // Load assistant-specific prompt instructions
      const assistantInstructions = await this.loadAssistantPrompt(assistantType);
      this.logger.log(`🔍 [DIRECT AI] Loaded assistant instructions: ${assistantInstructions.substring(0, 100)}...`);

      // For general assistant, check if question matches data.json
      // Skip data.json checking for booking assistant to allow pure AI processing
      if (assistantType === 'general') {
        this.logger.log(`🔍 [DIRECT AI] Checking data.json for exact match...`);
        const dataAnswer = await this.getAnswerFromData(question, assistantType);
        if (dataAnswer) {
          this.logger.log(`✅ [DIRECT AI] Found exact match in data.json: "${dataAnswer}"`);
          return dataAnswer;
        } else {
          this.logger.log(`❌ [DIRECT AI] No exact match found in data.json`);
        }
      } else if (assistantType === 'booking') {
        this.logger.log(`📋 [DIRECT AI] Booking mode: Skipping data.json check, using pure AI processing`);
      }

      // Get conversation history for context
      this.logger.log(`🔍 [DIRECT AI] Retrieving conversation history for session: ${sessionId}`);
      const conversationHistory = await this.getConversationHistory(sessionId);

      if (conversationHistory && conversationHistory.length > 0) {
        this.logger.log(`✅ [DIRECT AI] Found ${conversationHistory.length} previous interactions:`);
        conversationHistory.forEach((interaction, index) => {
          this.logger.log(`   ${index + 1}. Q: "${interaction.question}"`);
          this.logger.log(`      A: "${interaction.answer}"`);
        });
      } else {
        this.logger.log(`❌ [DIRECT AI] No conversation history found`);
      }

      // Build context-aware prompt
      let prompt = `${assistantInstructions}

      IMPORTANT: This question is not in your predefined knowledge base. However, you can use information from the conversation context below to answer questions about what the user has told you during this conversation.`;

      // Add conversation context if available
      if (conversationHistory && conversationHistory.length > 0) {
        prompt += `\n\nConversation Context:\n`;
        conversationHistory.forEach((interaction, index) => {
          prompt += `${index + 1}. User: ${interaction.question}\n`;
          prompt += `   Assistant: ${interaction.answer}\n`;
        });
        prompt += `\nCurrent Question: ${question}`;
        prompt += `\n\nPlease respond naturally considering the conversation context above. You can use information the user has shared during this conversation to answer their questions. If the current question relates to previous topics or information shared by the user, you can reference that information.`;
      } else {
        prompt += `\n\nQuestion: ${question}`;
        prompt += `\n\nSince there's no conversation context, respond naturally saying that you don't have specific information about this topic in your knowledge base, but you're happy to help with other questions that are available.`;
      }

      prompt += `\n\nProvide your response in a natural, conversational way suitable for a phone conversation.`;

      this.logger.log(`🔍 [DIRECT AI] Generated prompt length: ${prompt.length} characters`);
      this.logger.log(`🔍 [DIRECT AI] Prompt preview: ${prompt.substring(0, 200)}...`);

      const response = await this.aiProvider.invoke(prompt);
      this.logger.log(`✅ [DIRECT AI] AI Response: "${response.content}"`);

      return response.content;
    } catch (error) {
      this.logger.error('❌ [DIRECT AI] Error in direct AI response:', error);
      throw error;
    }
  }

  // Load assistant-specific prompt instructions from JSON files
  private async loadAssistantPrompt(assistantType: string): Promise<string> {
    try {
      const promptPath = path.join(__dirname, '..', '..', '..', 'src', 'twilio', 'assistant', assistantType, 'prompt.json');
      const fs = require('fs');
      const promptData = JSON.parse(fs.readFileSync(promptPath, 'utf8'));
      return promptData.prompt || promptData.instructions || 'You are a helpful assistant.';
    } catch (error) {
      this.logger.warn(`Could not load prompt for assistant type: ${assistantType}, using default prompt`);
      return 'You are a helpful assistant. Please provide accurate and helpful responses.';
    }
  }

  // Check if question matches data.json using AI-powered semantic matching
  private async getAnswerFromData(question: string, assistantType: string): Promise<string | null> {
    try {
      const dataPath = path.join(__dirname, '..', '..', '..', 'src', 'twilio', 'assistant', assistantType, 'data.json');
      const fs = require('fs');
      const dataContent = fs.readFileSync(dataPath, 'utf8');
      const qaData = JSON.parse(dataContent);

      this.logger.log(`🔍 [AI DATA MATCH] Using AI to find semantic match for: "${question}"`);

      // Create a prompt for AI to find the best matching question
      const questionsList = qaData.map((item, index) => `${index + 1}. "${item.question}"`).join('\n');

      const matchingPrompt = `
      You are a smart question matcher. I have a user question and a list of predefined questions with answers.

      USER QUESTION: "${question}"

      PREDEFINED QUESTIONS:
      ${questionsList}

      INSTRUCTIONS:
      1. Analyze the user's question and understand its intent/meaning
      2. Find the BEST matching question from the predefined list that has the SAME INTENT
      3. If you find a match, respond with ONLY the number (1, 2, 3, etc.) of the matching question
      4. If NO question matches the intent, respond with "NO_MATCH"

      EXAMPLES:
      - User: "can you tell me a joke" → Should match "Tell me a small joke" → Respond: "1"
      - User: "I want to hear a joke" → Should match "Tell me a small joke" → Respond: "1" 
      - User: "what's a funny joke?" → Should match "Tell me a small joke" → Respond: "1"
      - User: "what is the weather?" → No joke questions match → Respond: "NO_MATCH"

      RESPOND WITH ONLY THE NUMBER OR "NO_MATCH":`;

      // Use AI to find the best match
      const matchResult = await this.aiProvider.invoke(matchingPrompt);
      const matchResponse = matchResult.content.trim();

      this.logger.log(`🤖 [AI DATA MATCH] AI response: "${matchResponse}"`);

      // Check if AI found a match
      const matchNumber = parseInt(matchResponse);
      if (!isNaN(matchNumber) && matchNumber >= 1 && matchNumber <= qaData.length) {
        const matchedItem = qaData[matchNumber - 1];
        this.logger.log(`✅ [AI DATA MATCH] Found semantic match: "${matchedItem.question}" -> "${matchedItem.answer}"`);
        return matchedItem.answer;
      }

      // No match found
      this.logger.log(`❌ [AI DATA MATCH] No semantic match found for: "${question}"`);
      return null;
    } catch (error) {
      this.logger.warn(`Could not perform AI data matching for assistant type: ${assistantType}`, error);
      return null;
    }
  }

  // Get conversation history for context-aware responses
  private async getConversationHistory(sessionId?: string): Promise<Array<{ question: string; answer: string }> | null> {
    if (!sessionId) {
      this.logger.log(`🔍 [CONVERSATION HISTORY] No sessionId provided`);
      return null;
    }

    try {
      this.logger.log(`🔍 [CONVERSATION HISTORY] Retrieving session: ${sessionId}`);

      // Get session from conversation logger
      const session = await this.conversationLogger.getSession(sessionId);

      if (!session) {
        this.logger.log(`❌ [CONVERSATION HISTORY] Session not found: ${sessionId}`);
        return null;
      }

      if (!session.interactions || session.interactions.length === 0) {
        this.logger.log(`❌ [CONVERSATION HISTORY] No interactions found in session: ${sessionId}`);
        return null;
      }

      this.logger.log(`✅ [CONVERSATION HISTORY] Found ${session.interactions.length} total interactions in session`);

      // Get last 5 interactions for context (to avoid too long prompts)
      const recentInteractions = session.interactions.slice(-5);
      this.logger.log(`🔍 [CONVERSATION HISTORY] Using last ${recentInteractions.length} interactions for context`);

      const history = recentInteractions.map((interaction) => ({
        question: interaction.question,
        answer: interaction.answer || 'No answer available',
      }));

      this.logger.log(`✅ [CONVERSATION HISTORY] Returning conversation history:`, history);
      return history;
    } catch (error) {
      this.logger.warn(`❌ [CONVERSATION HISTORY] Could not retrieve conversation history for session ${sessionId}:`, error);
      return null;
    }
  }
}
