import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BookingSessionService, BookingSession } from './booking-session.service';
import { DirectAIService } from './direct-ai.service';
import { EmailService } from './email.service';
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

    this.logger.log(`🚀 [BOOKING] Started booking flow for call: ${callSid}`);

    return `Great! I'll help you with your booking. I'll ask you a few questions to collect your information. Let's start: Could you please tell me your full name?`;
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

    const currentQuestion = this.getQuestion(session.currentQuestionNo);
    if (!currentQuestion) {
      this.logger.warn(`📋 [BOOKING] No question found for number: ${session.currentQuestionNo}`);
      return "I'm sorry, there was an error with the booking process. Please try again.";
    }

    // Check for cancellation keywords
    if (this.isCancellationRequest(userInput)) {
      this.bookingSessionService.cancelBooking(callSid);
      return 'Booking cancelled. You can start a new booking anytime by pressing 1. Is there anything else I can help you with?';
    }

    // Process the user's answer using AI
    const processedAnswer = await this.processAnswerWithAI(userInput, currentQuestion, session);

    if (!processedAnswer || processedAnswer === 'INVALID') {
      // Generate a helpful re-prompting message based on question type
      const repromptMessage = this.generateRepromptMessage(currentQuestion, userInput);
      this.logger.log(`❌ [BOOKING] Invalid answer for Q${session.currentQuestionNo}: "${userInput}" -> Re-prompting`);
      return repromptMessage;
    }

    // Store the answer
    this.bookingSessionService.addAnswer(callSid, session.currentQuestionNo, currentQuestion.question, processedAnswer);
    this.logger.log(`✅ [BOOKING] Valid answer for Q${session.currentQuestionNo}: "${processedAnswer}"`);

    // Check if this is the last question
    if (session.currentQuestionNo >= this.bookingQuestions.length) {
      return await this.completeBooking(callSid);
    }

    // Move to next question
    this.bookingSessionService.moveToNextQuestion(callSid);
    const nextQuestion = this.getQuestion(session.currentQuestionNo + 1);

    return `Perfect! Thank you. Now, ${this.getQuestionPrompt(nextQuestion)}`;
  }

  /**
   * Processes user answer using AI to extract relevant information
   */
  private async processAnswerWithAI(userInput: string, question: any, session: BookingSession): Promise<string | null> {
    try {
      const prompt = this.buildAnswerProcessingPrompt(userInput, question, session);
      const response = await this.directAIService.getDirectAIResponse(prompt, 'general', session.callSid);

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
3. For age: Extract the number (e.g., "25", "twenty-five" → "25")
4. For gender: Extract "Male", "Female", or "Other"
5. For email: Extract the email address
6. For phone: Extract the phone number
7. For confirmation: Extract "Yes" or "No"

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

      case 2: // Age
        const age = parseInt(response);
        return !isNaN(age) && age > 0 && age < 150 ? age.toString() : null;

      case 3: // Gender
        const gender = response.toLowerCase();
        if (gender.includes('male') || gender.includes('man') || gender.includes('boy')) return 'Male';
        if (gender.includes('female') || gender.includes('woman') || gender.includes('girl')) return 'Female';
        if (gender.includes('other') || gender.includes('non-binary') || gender.includes('prefer not')) return 'Other';
        return null;

      case 4: // Email
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return emailRegex.test(response.trim()) ? response.trim() : null;

      case 5: // Phone
        const phoneRegex = /^[\+]?[1-9][\d]{7,15}$/;
        const cleanPhone = response.replace(/[\s\-\(\)\.]/g, '');
        return phoneRegex.test(cleanPhone) && cleanPhone.length >= 8 ? cleanPhone : null;

      case 6: // Confirmation
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
        return `I didn't catch your name there. You said "${userInput}" but I need your full name. Could you please tell me your first and last name?`;
      case 2: // Age
        return `I need your age as a number. You said "${userInput}" but could you please tell me how old you are? For example, "I am 25 years old" or just "25".`;
      case 3: // Gender
        return `I need to know your gender. You said "${userInput}" but could you please say "Male", "Female", or tell me your gender preference?`;
      case 4: // Email
        return `I need your email address. You said "${userInput}" but could you please give me your email address? For example, "john@email.com".`;
      case 5: // Phone
        return `I need your phone number. You said "${userInput}" but could you please give me your phone number with area code?`;
      case 6: // Confirmation
        return `I need to confirm your booking. You said "${userInput}" but could you please say "Yes" to confirm or "No" to cancel the booking?`;
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

    // Send email with booking details
    await this.sendBookingEmail(session, bookingRef);

    this.logger.log(`✅ [BOOKING] Completed booking ${bookingRef} for call: ${callSid}`);

    return `Excellent! Your booking has been confirmed. Your booking reference is ${bookingRef}. You'll receive a confirmation email shortly with all the details. Is there anything else I can help you with?`;
  }

  /**
   * Sends booking confirmation email
   */
  private async sendBookingEmail(session: BookingSession, bookingRef: string): Promise<void> {
    try {
      const bookingData = this.bookingSessionService.getBookingDataForDB(session.callSid);

      const emailContent = this.generateBookingEmailContent(bookingData, bookingRef);

      await this.emailService.sendEmail({
        to: bookingData.answers.question_4?.answer || 'admin@example.com',
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
          <li><strong>Age:</strong> ${answers.question_2?.answer || 'N/A'}</li>
          <li><strong>Gender:</strong> ${answers.question_3?.answer || 'N/A'}</li>
          <li><strong>Email:</strong> ${answers.question_4?.answer || 'N/A'}</li>
          <li><strong>Phone:</strong> ${answers.question_5?.answer || 'N/A'}</li>
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
    const questionNo = question['questionNo.'];

    switch (questionNo) {
      case 1:
        return 'could you please tell me your full name?';
      case 2:
        return 'what is your age?';
      case 3:
        return 'what is your gender?';
      case 4:
        return 'what is your email address?';
      case 5:
        return 'what is your phone number?';
      case 6:
        return 'do you want to confirm this booking with all the information you provided?';
      default:
        return question.question;
    }
  }

  /**
   * Checks if a call has an active booking session
   */
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
