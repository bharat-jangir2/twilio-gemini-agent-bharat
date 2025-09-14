import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BookingSessionService, BookingSession } from './booking-session.service';
import { DirectAIService } from './direct-ai.service';
import { EmailService } from './email.service';
import { BookingDataExtractionService } from './booking-data-extraction.service';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class BookingFlowService {
  private readonly logger = new Logger(BookingFlowService.name);
  private bookingQuestions: any[] = [];

  constructor(
    private readonly bookingSessionService: BookingSessionService,
    private readonly directAIService: DirectAIService,
    private readonly emailService: EmailService,
    private readonly configService: ConfigService,
    private readonly bookingDataExtractionService: BookingDataExtractionService,
  ) {
    this.loadBookingQuestions();
  }

  /**
   * Loads booking questions from JSON file
   */
  private loadBookingQuestions(): void {
    try {
      const questionsPath = path.join(process.cwd(), 'src/twilio/assistant/booking/bookingquestions.json');
      const questionsData = fs.readFileSync(questionsPath, 'utf8');
      this.bookingQuestions = JSON.parse(questionsData);
      this.logger.log(`📋 [BOOKING] Loaded ${this.bookingQuestions.length} booking questions`);
    } catch (error) {
      this.logger.error('Failed to load booking questions:', error);
      this.bookingQuestions = [];
    }
  }

  /**
   * Starts the booking flow for a call
   */
  startBookingFlow(callSid: string): string {
    const session = this.bookingSessionService.createBookingSession(callSid);
    const firstQuestion = this.getQuestion(1);

    // Log booking start
    this.logBookingStart(session);

    return `Great! I'll help you with your booking. I'll ask you a few questions to collect your information. Let's start: Could you please tell me your full name?`;
  }

  /**
   * Logs booking start summary
   */
  private logBookingStart(session: BookingSession): void {
    try {
      const startTime = new Date(session.createdAt);

      this.logger.log(`
      ╔══════════════════════════════════════════════════════════════╗
      ║                    🚀 BOOKING FLOW STARTED                   ║
      ╠══════════════════════════════════════════════════════════════╣
      ║ 📞 Call SID:          ${session.callSid}                      ║
      ║ ⏰ Started:           ${startTime.toLocaleString()}           ║
      ║ 📊 Status:            ${session.status}                      ║
      ║ 📝 Total Questions:   4 questions to complete               ║
      ║ 🎯 Current Question:  Q1 - Name                             ║
      ╠══════════════════════════════════════════════════════════════╣
      ║                        📋 QUESTION FLOW                      ║
      ╠══════════════════════════════════════════════════════════════╣
      ║ Q1: What's your full name?                                  ║
      ║ Q2: What's your email address?                              ║
      ║ Q3: What's your phone number?                               ║
      ║ Q4: Do you want to confirm this booking?                    ║
      ╚══════════════════════════════════════════════════════════════╝
      `);
    } catch (error) {
      this.logger.error('❌ [BOOKING] Error logging booking start:', error);
    }
  }

  /**
   * Processes user response and determines next action
   */
  async processBookingResponse(callSid: string, userInput: string): Promise<string> {
    const session = this.bookingSessionService.getBookingSession(callSid);
    if (!session) {
      this.logger.warn(`📋 [BOOKING] No active session found for call: ${callSid}`);
      return "I'm sorry, I don't have an active booking session. Please start over by pressing 1.";
    }

    // Check for cancellation keywords
    if (this.isCancellationRequest(userInput)) {
      this.logBookingCancellation(session, userInput);
      this.bookingSessionService.cancelBooking(callSid);
      return 'Booking cancelled. You can start a new booking anytime by pressing 1. Is there anything else I can help you with?';
    }

    // Check if we're awaiting confirmation for the last answer
    if (session.awaitingConfirmation) {
      return this.handleConfirmationResponse(callSid, userInput, session);
    }

    const currentQuestion = this.getQuestion(session.currentQuestionNo);
    if (!currentQuestion) {
      this.logger.warn(`📋 [BOOKING] No question found for number: ${session.currentQuestionNo}`);
      return "I'm sorry, there was an error with the booking process. Please try again.";
    }

    // Process the user's answer using fast regex validation
    const startTime = Date.now();
    const processedAnswer = await this.processAnswerOptimized(userInput, currentQuestion, session);
    const processingTime = Date.now() - startTime;

    if (!processedAnswer || processedAnswer === 'INVALID') {
      // Generate a helpful re-prompting message based on question type
      const repromptMessage = this.generateRepromptMessage(currentQuestion, userInput);
      this.logger.log(
        `❌ [BOOKING] Invalid answer for Q${session.currentQuestionNo}: "${userInput}" -> Re-prompting (${processingTime}ms)`,
      );
      return repromptMessage;
    }

    // Instead of storing the answer immediately, set it for confirmation
    this.bookingSessionService.setAwaitingConfirmation(callSid, session.currentQuestionNo, processedAnswer);
    this.logger.log(`📋 [BOOKING] Answer extracted for Q${session.currentQuestionNo}: "${processedAnswer}" - Awaiting confirmation (${processingTime}ms)`);

    // Generate confirmation message
    return this.generateConfirmationMessage(currentQuestion, processedAnswer);
  }

  /**
   * Handles confirmation response (DTMF 4 or 5)
   */
  private async handleConfirmationResponse(callSid: string, userInput: string, session: BookingSession): Promise<string> {
    const input = userInput.toLowerCase().trim();
    
    // Check for DTMF or voice confirmation
    if (input === '4' || input.includes('yes') || input.includes('correct') || input.includes('right')) {
      // User confirmed the answer
      const confirmed = this.bookingSessionService.confirmAnswer(callSid);
      if (confirmed) {
        this.logger.log(`✅ [BOOKING] Answer confirmed for Q${session.lastQuestionNo} in call: ${callSid}`);
        
        // Check if this was the last question
        if (session.currentQuestionNo >= this.bookingQuestions.length) {
          this.logger.log(`🏁 [BOOKING] Last question completed, proceeding to booking completion`);
          return await this.completeBooking(callSid);
        }

        // Move to next question
        this.bookingSessionService.moveToNextQuestion(callSid);
        const nextQuestion = this.getQuestion(session.currentQuestionNo);

        if (!nextQuestion) {
          this.logger.error(`❌ [BOOKING] No question found for number: ${session.currentQuestionNo}`);
          return await this.completeBooking(callSid);
        }

        // Log question progression
        this.logQuestionProgression(session, nextQuestion);

        return `Perfect! Thank you. Now, ${this.getQuestionPrompt(nextQuestion)}`;
      }
    } else if (input === '5' || input.includes('no') || input.includes('incorrect') || input.includes('wrong')) {
      // User rejected the answer
      this.bookingSessionService.rejectAnswer(callSid);
      this.logger.log(`❌ [BOOKING] Answer rejected for Q${session.lastQuestionNo} in call: ${callSid}`);
      
      const currentQuestion = this.getQuestion(session.currentQuestionNo);
      if (currentQuestion) {
        return `No problem! Let me ask that question again. ${this.getQuestionPrompt(currentQuestion)}`;
      }
    }

    // Invalid confirmation response
    return `I need you to confirm your answer. Press 4 if "${session.lastAnswer}" is correct, or press 5 if it's incorrect.`;
  }

  /**
   * Generates confirmation message for extracted answer
   */
  private generateConfirmationMessage(question: any, answer: string): string {
    const questionNo = question['questionNo.'];
    
    switch (questionNo) {
      case 1: // Name
        return `I heard your name as "${answer}". Is this correct? Press 4 for yes, or press 5 for no.`;
      case 2: // Email
        return `I heard your email as "${answer}". Is this correct? Press 4 for yes, or press 5 for no.`;
      case 3: // Phone
        return `I heard your phone number as "${answer}". Is this correct? Press 4 for yes, or press 5 for no.`;
      case 4: // Confirmation
        return `I heard your confirmation as "${answer}". Is this correct? Press 4 for yes, or press 5 for no.`;
      default:
        return `I heard your answer as "${answer}". Is this correct? Press 4 for yes, or press 5 for no.`;
    }
  }

  /**
   * Logs question progression
   */
  private logQuestionProgression(session: BookingSession, nextQuestion: any): void {
    try {
      if (!nextQuestion) {
        this.logger.warn('❌ [BOOKING] Cannot log progression - next question is undefined');
        return;
      }

      const completedQuestions = Object.keys(session.answers).length;
      const totalQuestions = this.bookingQuestions.length;
      const progressPercentage = Math.round((completedQuestions / totalQuestions) * 100);

      this.logger.log(`
      ╔══════════════════════════════════════════════════════════════╗
      ║                    📈 BOOKING PROGRESS UPDATE                ║
      ╠══════════════════════════════════════════════════════════════╣
      ║ 📞 Call SID:          ${session.callSid}                      ║
      ║ 📊 Progress:          ${completedQuestions}/${totalQuestions} questions (${progressPercentage}%)  ║
      ║ ➡️  Next Question:     Q${nextQuestion['questionNo.']} - ${nextQuestion.question} ║
      ╚══════════════════════════════════════════════════════════════╝`);
    } catch (error) {
      this.logger.error('❌ [BOOKING] Error logging question progression:', error);
    }
  }

  /**
   * Optimized answer processing: Smart extraction first, then regex, then AI fallback
   */
  private async processAnswerOptimized(userInput: string, question: any, session: BookingSession): Promise<string | null> {
    try {
      const questionNo = question['questionNo.'];
      
      // Use smart extraction for email and mobile number questions
      if (questionNo === 2) { // Email question
        this.logger.log(`📧 [BOOKING] Using smart email extraction for: "${userInput}"`);
        const extractionResult = await this.bookingDataExtractionService.extractEmail(userInput);
        
        if (extractionResult.success && extractionResult.extractedValue) {
          this.logger.log(`✅ [BOOKING] Smart email extraction successful: "${extractionResult.extractedValue}" (confidence: ${extractionResult.confidence})`);
          return extractionResult.extractedValue;
        } else {
          this.logger.warn(`❌ [BOOKING] Smart email extraction failed, trying fallback methods`);
          // Log the processing steps for debugging
          extractionResult.processedSteps.forEach((step, index) => {
            this.logger.debug(`📧 [EMAIL] Step ${index + 1}: ${step}`);
          });
        }
      } else if (questionNo === 3) { // Mobile number question
        this.logger.log(`📱 [BOOKING] Using smart mobile extraction for: "${userInput}"`);
        const extractionResult = await this.bookingDataExtractionService.extractMobileNumber(userInput);
        
        if (extractionResult.success && extractionResult.extractedValue) {
          this.logger.log(`✅ [BOOKING] Smart mobile extraction successful: "${extractionResult.extractedValue}" (confidence: ${extractionResult.confidence})`);
          return extractionResult.extractedValue;
        } else {
          this.logger.warn(`❌ [BOOKING] Smart mobile extraction failed, trying fallback methods`);
          // Log the processing steps for debugging
          extractionResult.processedSteps.forEach((step, index) => {
            this.logger.debug(`📱 [MOBILE] Step ${index + 1}: ${step}`);
          });
        }
      }

      // Try fast regex validation for all questions (sub-millisecond)
      const regexResult = this.validateWithRegex(userInput, questionNo);
      if (regexResult) {
        this.logger.log(`⚡ [BOOKING] Fast validation successful: "${regexResult}"`);
        return regexResult;
      }

      // Only use AI for complex cases that regex couldn't handle
      this.logger.log(`🤖 [BOOKING] Regex validation failed, using AI fallback for: "${userInput}"`);
      const aiStartTime = Date.now();

      try {
        const result = await this.processAnswerWithAI(userInput, question, session);
        const aiTime = Date.now() - aiStartTime;
        this.logger.log(`🤖 [BOOKING] AI fallback completed in ${aiTime}ms`);
        return result;
      } catch (aiError) {
        const aiTime = Date.now() - aiStartTime;
        this.logger.error(`❌ [BOOKING] AI fallback failed after ${aiTime}ms:`, aiError.message);

        // Try one more time with a simpler approach for common edge cases
        const simpleResult = this.handleCommonEdgeCases(userInput, questionNo);
        if (simpleResult) {
          this.logger.log(`✅ [BOOKING] Edge case handled: "${simpleResult}"`);
          return simpleResult;
        }

        // If all else fails, return null to trigger re-prompting with a helpful message
        this.logger.warn(`🚨 [BOOKING] AI service unavailable, falling back to re-prompting for: "${userInput}"`);
        return null;
      }
    } catch (error) {
      this.logger.error('Error in optimized answer processing:', error);
      return null;
    }
  }

  /**
   * Handle common edge cases that regex might miss but don't need AI
   */
  private handleCommonEdgeCases(userInput: string, questionNo: number): string | null {
    const input = userInput.toLowerCase().trim();

    switch (questionNo) {
      case 1: // Name edge cases
        // Handle "my name is..." or "I'm..."
        if (input.includes('my name is')) {
          const name = input.replace(/.*my name is\s*/i, '').trim();
          if (name.length >= 2 && /^[a-zA-Z\s\'\-\.]{2,50}$/.test(name)) {
            return name;
          }
        }
        if (input.includes("i'm ") || input.includes('i am ')) {
          const name = input
            .replace(/.*i'?m\s*/i, '')
            .replace(/.*i am\s*/i, '')
            .trim();
          if (name.length >= 2 && /^[a-zA-Z\s\'\-\.]{2,50}$/.test(name)) {
            return name;
          }
        }
        break;

      case 2: // Email edge cases
        // Handle "my email is..." or casual formats
        const emailMatch = input.match(/[a-zA-Z0-9._%+-]+\s*@\s*[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
        if (emailMatch) {
          return emailMatch[0].replace(/\s/g, '').toLowerCase();
        }

        // Handle "email at domain dot com" format
        const wordyEmail = input.match(/(\w+)\s*at\s*(\w+)\s*dot\s*(\w+)/);
        if (wordyEmail) {
          return `${wordyEmail[1]}@${wordyEmail[2]}.${wordyEmail[3]}`.toLowerCase();
        }

        // Handle common email providers mentioned by name
        const emailProviders = this.extractEmailFromNaturalLanguage(input);
        if (emailProviders) {
          return emailProviders.toLowerCase();
        }
        break;

      case 3: // Phone edge cases
        // Extract any sequence of digits that looks like a phone number
        const phoneDigits = input.replace(/\D/g, '');
        if (phoneDigits.length >= 8 && phoneDigits.length <= 15) {
          return phoneDigits;
        }
        break;

      case 4: // Confirmation edge cases
        // More flexible confirmation detection
        if (/\b(yep|yup|yeah|affirmative|correct|approve|accept|go ahead)\b/.test(input)) {
          return 'Yes';
        }
        if (/\b(nope|negative|decline|reject|abort)\b/.test(input)) {
          return 'No';
        }
        break;
    }

    return null;
  }

  /**
   * Extract email from natural language mentioning email providers
   */
  private extractEmailFromNaturalLanguage(input: string): string | null {
    const lowerInput = input.toLowerCase();

    // Common email provider patterns
    const emailProviders = {
      gmail: 'gmail.com',
      'g mail': 'gmail.com',
      'google mail': 'gmail.com',
      yahoo: 'yahoo.com',
      'yahoo mail': 'yahoo.com',
      hotmail: 'hotmail.com',
      outlook: 'outlook.com',
      aol: 'aol.com',
      icloud: 'icloud.com',
      apple: 'icloud.com',
      protonmail: 'protonmail.com',
      proton: 'protonmail.com',
    };

    // Try to extract username and provider
    let username: string | null = null;
    let domain: string | null = null;

    // Pattern 1: "john gmail" or "john at gmail"
    for (const [providerName, providerDomain] of Object.entries(emailProviders)) {
      const pattern1 = new RegExp(`([a-zA-Z0-9._%+-]+)\\s+(?:at\\s+)?${providerName.replace(/\s/g, '\\s*')}`, 'i');
      const match1 = lowerInput.match(pattern1);
      if (match1) {
        username = match1[1];
        domain = providerDomain;
        break;
      }

      // Pattern 2: "gmail john" or "gmail user john"
      const pattern2 = new RegExp(`${providerName.replace(/\s/g, '\\s*')}\\s+(?:user\\s+|account\\s+)?([a-zA-Z0-9._%+-]+)`, 'i');
      const match2 = lowerInput.match(pattern2);
      if (match2) {
        username = match2[1];
        domain = providerDomain;
        break;
      }

      // Pattern 3: "my gmail is john" or "email is john gmail"
      const pattern3 = new RegExp(
        `(?:my\\s+)?(?:email\\s+is\\s+)?([a-zA-Z0-9._%+-]+)\\s+${providerName.replace(/\s/g, '\\s*')}`,
        'i',
      );
      const match3 = lowerInput.match(pattern3);
      if (match3) {
        username = match3[1];
        domain = providerDomain;
        break;
      }
    }

    // Pattern 4: Extract from "john dot smith gmail" or "john underscore smith yahoo"
    if (!username && !domain) {
      for (const [providerName, providerDomain] of Object.entries(emailProviders)) {
        const complexPattern = new RegExp(
          `([a-zA-Z0-9]+(?:\\s+(?:dot|period|\\.)+\\s+[a-zA-Z0-9]+|\\s+(?:underscore|_)+\\s+[a-zA-Z0-9]+)*)\\s+${providerName.replace(/\s/g, '\\s*')}`,
          'i',
        );
        const complexMatch = lowerInput.match(complexPattern);
        if (complexMatch) {
          username = complexMatch[1]
            .replace(/\s+(?:dot|period)\s+/g, '.')
            .replace(/\s+(?:underscore|_)\s+/g, '_')
            .replace(/\s+/g, '');
          domain = providerDomain;
          break;
        }
      }
    }

    // If we found both username and domain, construct email
    if (username && domain) {
      const email = `${username}@${domain}`;
      // Validate the constructed email
      const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
      if (emailRegex.test(email)) {
        return email;
      }
    }

    return null;
  }

  /**
   * Fast regex-based validation for booking answers
   */
  private validateWithRegex(userInput: string, questionNo: number): string | null {
    const input = userInput.trim();

    switch (questionNo) {
      case 1: // Name
        // Name should have at least 2 characters and not be common non-answers
        const nameCheck = input.toLowerCase();
        const invalidNames = ['okay', 'ok', 'yes', 'no', 'hello', 'hi', 'nothing', 'none', 'good', 'fine'];
        if (input.length >= 2 && !invalidNames.includes(nameCheck)) {
          // Check if it looks like a name (letters, spaces, common name chars)
          const namePattern = /^[a-zA-Z\s\'\-\.]{2,50}$/;
          if (namePattern.test(input)) {
            return input;
          }
        }
        return null;

      case 2: // Email
        // Try multiple email extraction approaches

        // 1. Standard email regex
        const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/;
        const emailMatch = input.match(emailRegex);
        if (emailMatch) {
          return emailMatch[0].toLowerCase();
        }

        // 2. Handle common provider mentions
        const naturalEmail = this.extractEmailFromNaturalLanguage(input);
        if (naturalEmail) {
          return naturalEmail;
        }

        return null;

      case 3: // Phone
        // Extract phone number (various formats)
        const phoneRegex = /[\d\s\-\(\)\+\.]{8,20}/;
        const phoneMatch = input.match(phoneRegex);
        if (phoneMatch) {
          // Clean phone number (keep only digits and +)
          const cleaned = phoneMatch[0].replace(/[^\d\+]/g, '');
          if (cleaned.length >= 8 && cleaned.length <= 15) {
            return cleaned;
          }
        }
        return null;

      case 4: // Confirmation
        const lowerInput = input.toLowerCase();
        // Positive confirmation
        if (/\b(yes|y|yeah|yep|sure|ok|okay|confirm|confirmed|correct|right|true|proceed)\b/i.test(lowerInput)) {
          return 'Yes';
        }
        // Negative confirmation
        if (/\b(no|n|nope|nah|cancel|cancelled|wrong|false|stop|quit)\b/i.test(lowerInput)) {
          return 'No';
        }
        return null;

      default:
        return null;
    }
  }

  /**
   * Processes user answer using AI to extract relevant information (FALLBACK)
   */
  private async processAnswerWithAI(userInput: string, question: any, session: BookingSession): Promise<string | null> {
    try {
      const prompt = this.buildAnswerProcessingPrompt(userInput, question, session);

      // Use 'booking' assistant type to bypass data.json and enable pure AI processing
      const response = await this.directAIService.getDirectAIResponse(prompt, 'booking', session.callSid);

      // Extract the processed answer from AI response
      const processedAnswer = this.extractAnswerFromAIResponse(response, question);
      return processedAnswer;
    } catch (error) {
      this.logger.error('Error processing answer with AI:', error);
      return null;
    }
  }

  /**
   * Builds prompt for AI to process user answers
   */
  private buildAnswerProcessingPrompt(userInput: string, question: any, session: BookingSession): string {
    const context = session.answers.map((a) => `Q${a.questionNo}: ${a.question} - A: ${a.answer}`).join('\n');

    return `
      You are a booking assistant processing user responses. Extract the relevant information from the user's natural language response.

      CURRENT QUESTION: "${question.question}" (Question #${question['questionNo.']})

      USER RESPONSE: "${userInput}"

      PREVIOUS ANSWERS:
      ${context || 'None yet'}

      INSTRUCTIONS:
      1. Extract the most relevant information from the user's response for the current question
      2. For name: Extract the full name
      3. For email: Extract the email address
      4. For phone: Extract the phone number
      5. For confirmation: Extract "Yes" or "No"

      RESPOND WITH ONLY THE EXTRACTED INFORMATION, nothing else.
      If the response doesn't contain relevant information, respond with "INVALID".
      `;
  }

  /**
   * Extracts answer from AI response
   */
  private extractAnswerFromAIResponse(aiResponse: string, question: any): string | null {
    const response = aiResponse.trim();

    if (response === 'INVALID' || response.length === 0) {
      return null;
    }

    // Basic validation based on question type
    switch (question['questionNo.']) {
      case 1: // Name
        // Name should have at least 2 characters and not be common non-answers
        const nameCheck = response.toLowerCase().trim();
        const invalidNames = ['okay', 'ok', 'yes', 'no', 'hello', 'hi', 'nothing', 'none'];
        if (response.length < 2 || invalidNames.includes(nameCheck)) {
          return null;
        }
        return response.trim();

      case 2: // Email
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return emailRegex.test(response.trim()) ? response.trim() : null;

      case 3: // Phone
        const phoneRegex = /^[\+]?[1-9][\d]{7,15}$/;
        const cleanPhone = response.replace(/[\s\-\(\)\.]/g, '');
        return phoneRegex.test(cleanPhone) && cleanPhone.length >= 8 ? cleanPhone : null;

      case 4: // Confirmation
        const confirmation = response.toLowerCase();
        if (confirmation.includes('yes') || confirmation.includes('confirm') || confirmation.includes('y')) return 'Yes';
        if (confirmation.includes('no') || confirmation.includes('cancel') || confirmation.includes('n')) return 'No';
        return null;

      default:
        return response.trim().length > 0 ? response.trim() : null;
    }
  }

  /**
   * Generates a helpful re-prompting message based on question type
   */
  private generateRepromptMessage(question: any, userInput: string): string {
    const questionNo = question['questionNo.'];

    switch (questionNo) {
      case 1: // Name
        return `I didn't catch your name there. You said "${userInput}" but I need your full name. Could you please clearly say your first and last name? For example, "John Smith".`;
      case 2: // Email
        return `I need your email address. You said "${userInput}" but I couldn't extract a valid email. Please try saying it clearly in any of these formats: "john@gmail.com", "john at gmail dot com", "john gmail", or "john smith at yahoo dot com".`;
      case 3: // Phone
        return `I need your phone number. You said "${userInput}" but I couldn't extract a valid phone number. Please try saying it clearly, like "1234567890", "123-456-7890", or "plus 91 1234567890".`;
      case 4: // Confirmation
        return `I need to confirm your booking. You said "${userInput}" but could you please clearly say "Yes" to confirm or "No" to cancel the booking?`;
      default:
        return `I didn't quite understand that. You said "${userInput}". Could you please answer: ${question.question}`;
    }
  }

  /**
   * Checks if user wants to cancel the booking
   */
  private isCancellationRequest(userInput: string): boolean {
    const cancelKeywords = ['cancel', 'stop', 'quit', 'exit', 'no', 'never mind', 'forget it'];
    const input = userInput.toLowerCase();
    return cancelKeywords.some((keyword) => input.includes(keyword));
  }

  /**
   * Completes the booking and sends email
   */
  private async completeBooking(callSid: string): Promise<string> {
    const session = this.bookingSessionService.completeBooking(callSid);
    if (!session) {
      return "I'm sorry, there was an error completing your booking.";
    }

    // Generate booking reference
    const bookingRef = `BK-${Date.now().toString().slice(-6)}`;

    // Log comprehensive booking summary
    this.logBookingSummary(session, bookingRef);

    // Send email with booking details
    await this.sendBookingEmail(session, bookingRef);

    this.logger.log(`✅ [BOOKING] Completed booking ${bookingRef} for call: ${callSid}`);

    return `Excellent! Your booking has been confirmed. Your booking reference is ${bookingRef}. You'll receive a confirmation email shortly with all the details. Is there anything else I can help you with?`;
  }

  /**
   * Logs comprehensive booking summary
   */
  private logBookingSummary(session: BookingSession, bookingRef: string): void {
    try {
      const answers = session.answers;
      const startTime = new Date(session.createdAt);
      const endTime = new Date();
      const duration = Math.round((endTime.getTime() - startTime.getTime()) / 1000); // seconds

      this.logger.log(`
      ╔══════════════════════════════════════════════════════════════╗
      ║                    📋 BOOKING COMPLETED SUMMARY              ║
      ╠══════════════════════════════════════════════════════════════╣
      ║ 🎫 Booking Reference: ${bookingRef}                          ║
      ║ 📞 Call SID:          ${session.callSid}                     ║
      ║ ⏰ Started:           ${startTime.toLocaleString()}          ║
      ║ ⏰ Completed:         ${endTime.toLocaleString()}            ║
      ║ ⏱️  Duration:          ${duration} seconds                   ║
      ║ 📊 Status:            ${session.status}                      ║
      ║ ⚡ Performance:       Optimized fast validation enabled       ║
      ╠══════════════════════════════════════════════════════════════╣
      ║                        📝 CUSTOMER DETAILS                   ║
      ╠══════════════════════════════════════════════════════════════╣
      ║ 👤 Name:             ${answers[1]?.answer || 'N/A'}          ║
      ║ 📧 Email:            ${answers[2]?.answer || 'N/A'}          ║
      ║ 📱 Phone:            ${answers[3]?.answer || 'N/A'}          ║
      ║ ✅ Confirmed:        ${answers[4]?.answer || 'N/A'}          ║
      ╠══════════════════════════════════════════════════════════════╣
      ║                        🔄 QUESTION FLOW                      ║
      ╚══════════════════════════════════════════════════════════════╝`);

      // Log detailed question flow
      Object.keys(answers).forEach((questionNo) => {
        const answer = answers[questionNo];
        this.logger.log(`   Q${questionNo}: ${answer.question}`);
        this.logger.log(`   A${questionNo}: ${answer.answer}`);
        this.logger.log(`   ──────────────────────────────────────────────────`);
      });

      this.logger.log(`
      ╔══════════════════════════════════════════════════════════════╗
      ║ ✅ BOOKING SUMMARY LOGGED SUCCESSFULLY                       ║
      ║ 📧 Confirmation email will be sent to: ${answers[2]?.answer || 'admin@example.com'} ║
      ╚══════════════════════════════════════════════════════════════╝
      `);
    } catch (error) {
      this.logger.error('❌ [BOOKING] Error logging booking summary:', error);
    }
  }

  /**
   * Logs booking cancellation summary
   */
  private logBookingCancellation(session: BookingSession, userInput: string): void {
    try {
      const answers = session.answers;
      const startTime = new Date(session.createdAt);
      const endTime = new Date();
      const duration = Math.round((endTime.getTime() - startTime.getTime()) / 1000); // seconds
      const completedQuestions = Object.keys(answers).length;

      this.logger.log(`
      ╔══════════════════════════════════════════════════════════════╗
      ║                    ❌ BOOKING CANCELLED SUMMARY               ║
      ╠══════════════════════════════════════════════════════════════╣
      ║ 📞 Call SID:          ${session.callSid}                      ║
      ║ ⏰ Started:           ${startTime.toLocaleString()}           ║
      ║ ❌ Cancelled:         ${endTime.toLocaleString()}             ║
      ║ ⏱️  Duration:          ${duration} seconds                    ║
      ║ 📊 Status:            cancelled                              ║
      ║ 💬 Cancel Reason:     "${userInput}"                         ║
      ║ ✅ Questions Done:    ${completedQuestions}/4                ║
      ║ 📝 Current Question:  Q${session.currentQuestionNo}          ║
      ╠══════════════════════════════════════════════════════════════╣
      ║                    📝 PARTIAL ANSWERS COLLECTED              ║
      ╚══════════════════════════════════════════════════════════════╝`);

      // Log answers collected before cancellation
      if (completedQuestions > 0) {
        Object.keys(answers).forEach((questionNo) => {
          const answer = answers[questionNo];
          this.logger.log(`   Q${questionNo}: ${answer.question}`);
          this.logger.log(`   A${questionNo}: ${answer.answer}`);
          this.logger.log(`   ──────────────────────────────────────────────────`);
        });
      } else {
        this.logger.log(`   📝 No answers collected before cancellation`);
      }

      this.logger.log(`
      ╔══════════════════════════════════════════════════════════════╗
      ║ ❌ BOOKING CANCELLATION LOGGED SUCCESSFULLY                  ║
      ╚══════════════════════════════════════════════════════════════╝
      `);
    } catch (error) {
      this.logger.error('❌ [BOOKING] Error logging booking cancellation:', error);
    }
  }

  /**
   * Sends booking confirmation email
   */
  private async sendBookingEmail(session: BookingSession, bookingRef: string): Promise<void> {
    try {
      const bookingData = this.bookingSessionService.getBookingDataForDB(session.callSid);

      const emailContent = this.generateBookingEmailContent(bookingData, bookingRef);

      await this.emailService.sendEmail({
        to: bookingData.answers.question_2?.answer || 'admin@example.com', // Question 2 is now email
        subject: `Booking Confirmation - ${bookingRef}`,
        html: emailContent,
      });

      this.logger.log(`📧 [BOOKING] Sent confirmation email for booking ${bookingRef}`);
    } catch (error) {
      this.logger.error('Failed to send booking email:', error);
    }
  }

  /**
   * Generates HTML email content for booking confirmation
   */
  private generateBookingEmailContent(bookingData: any, bookingRef: string): string {
    const answers = bookingData.answers;

    return `
    <html>
      <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Booking Confirmation</h2>
        <p><strong>Booking Reference:</strong> ${bookingRef}</p>
        <p><strong>Date:</strong> ${new Date().toLocaleDateString()}</p>
        
        <h3>Booking Details:</h3>
        <ul>
          <li><strong>Name:</strong> ${answers.question_1?.answer || 'N/A'}</li>
          <li><strong>Email:</strong> ${answers.question_2?.answer || 'N/A'}</li>
          <li><strong>Phone:</strong> ${answers.question_3?.answer || 'N/A'}</li>
          <li><strong>Confirmed:</strong> ${answers.question_4?.answer || 'N/A'}</li>
        </ul>
        
        <p>Thank you for your booking! We'll contact you soon with further details.</p>
        
        <hr>
        <p><small>This is an automated booking confirmation email.</small></p>
      </body>
    </html>
    `;
  }

  /**
   * Gets a question by number
   */
  private getQuestion(questionNo: number): any {
    return this.bookingQuestions.find((q) => q['questionNo.'] === questionNo);
  }

  /**
   * Gets a natural question prompt
   */
  private getQuestionPrompt(question: any): string {
    if (!question) {
      this.logger.error('❌ [BOOKING] Cannot get question prompt - question is undefined');
      return 'let me complete your booking...';
    }

    const questionNo = question['questionNo.'];

    switch (questionNo) {
      case 1:
        return 'could you please tell me your full name?';
      case 2:
        return 'what is your email address?';
      case 3:
        return 'what is your phone number?';
      case 4:
        return 'do you want to confirm this booking with all the information you provided?';
      default:
        return question.question || 'let me complete your booking...';
    }
  }

  /**
   * Checks if a call has an active booking session
   **/
  hasActiveBookingSession(callSid: string): boolean {
    const session = this.bookingSessionService.getBookingSession(callSid);
    return session !== null && session.status === 'active';
  }

  /**
   * Clears booking session when call ends
   */
  clearBookingSession(callSid: string): void {
    this.bookingSessionService.clearBookingSession(callSid);
    this.logger.log(`🧹 [BOOKING] Cleared booking session for call: ${callSid}`);
  }
}
