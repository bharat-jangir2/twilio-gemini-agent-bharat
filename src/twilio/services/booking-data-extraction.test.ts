import { BookingDataExtractionService } from './booking-data-extraction.service';

/**
 * Test file to demonstrate the BookingDataExtractionService functionality
 * This file shows various test cases for email and mobile number extraction
 */

async function testBookingDataExtraction() {
  const service = new BookingDataExtractionService();

  console.log('🧪 Testing BookingDataExtractionService\n');

  // Test cases for email extraction
  const emailTestCases = [
    'john at gmail dot com',
    'jane smith at yahoo dot com',
    'my email is test at outlook dot com',
    'please email me at user at gmail dot com',
    'john underscore doe at hotmail dot com',
    'jane dash smith at gmail dot com',
    'test plus one at gmail dot com',
    'john gmail', // Should suggest john@gmail.com
    'jane at yahoo', // Should suggest jane@yahoo.com
    'my email is john at g mail dot c o m', // Spelled out
    'jane at out look dot com', // ASR error
    'test at g m a i l dot com', // ASR error
  ];

  console.log('📧 Email Extraction Tests:');
  console.log('=' .repeat(50));
  
  for (const testCase of emailTestCases) {
    const result = await service.extractEmail(testCase);
    console.log(`Input: "${testCase}"`);
    console.log(`Result: ${result.success ? '✅' : '❌'} ${result.extractedValue || 'Failed'}`);
    console.log(`Confidence: ${result.confidence}`);
    if (result.suggestions && result.suggestions.length > 0) {
      console.log(`Suggestions: ${result.suggestions.join(', ')}`);
    }
    console.log('---');
  }

  console.log('\n📱 Mobile Number Extraction Tests:');
  console.log('=' .repeat(50));

  // Test cases for mobile number extraction
  const mobileTestCases = [
    'my phone number is nine eight seven six five four three two one zero',
    'please call me at one two three four five six seven eight nine zero',
    'my mobile is plus nine one nine eight seven six five four three two one zero',
    'phone number nine eight seven six five four three two one zero',
    'call me at 9876543210',
    'my number is 91 9876543210',
    'plus 91 9876543210',
    'zero nine eight seven six five four three two one zero',
    'nine eight seven six five four three two one zero',
    'my contact is nine eight seven six five four three two one zero',
  ];

  for (const testCase of mobileTestCases) {
    const result = await service.extractMobileNumber(testCase);
    console.log(`Input: "${testCase}"`);
    console.log(`Result: ${result.success ? '✅' : '❌'} ${result.extractedValue || 'Failed'}`);
    console.log(`Confidence: ${result.confidence}`);
    if (result.suggestions && result.suggestions.length > 0) {
      console.log(`Suggestions: ${result.suggestions.join(', ')}`);
    }
    console.log('---');
  }

  console.log('\n🎯 Processing Steps Example:');
  console.log('=' .repeat(50));
  
  // Show detailed processing steps for a complex case
  const complexEmail = 'my email is john underscore smith at g mail dot c o m';
  const complexResult = await service.extractEmail(complexEmail);
  
  console.log(`Input: "${complexEmail}"`);
  console.log(`Result: ${complexResult.success ? '✅' : '❌'} ${complexResult.extractedValue || 'Failed'}`);
  console.log('\nProcessing Steps:');
  complexResult.processedSteps.forEach((step, index) => {
    console.log(`${index + 1}. ${step}`);
  });
}

// Run the test if this file is executed directly
if (require.main === module) {
  testBookingDataExtraction().catch(console.error);
}

export { testBookingDataExtraction };
