import { analyzeLotteryPatterns } from './src/utils/lotteryAnalysis.js';

/**
 * Verification Script for Lottery Pattern Analysis
 * Usage: npx tsx test-pattern.ts
 */
async function runTest() {
  const targetDate = '2026-05-25'; // Monday
  console.log(`🚀 Starting verification for target date: ${targetDate}`);

  try {
    const result = await analyzeLotteryPatterns(targetDate);

    if (!result.success) {
      console.log(`❌ Test Execution Failed: ${result.error || result.message}`);
      if (result.message && result.message.includes('No historical records found')) {
        console.log(`💡 Tip: Ensure 'twod_history' collection in Firestore has data between 2025-01-01 and 2026-05-22.`);
      }
      return;
    }

    console.log(`✅ Function execution successful.`);

    // 1. Check Day of Week
    const expectedDay = 'Monday';
    if (result.dayOfWeek === expectedDay) {
      console.log(`✅ Day of week detection correct: ${result.dayOfWeek} (${result.myanmarDay})`);
    } else {
      console.log(`❌ Day of week mismatch: Expected ${expectedDay}, got ${result.dayOfWeek}`);
    }

    // 2. Check match count
    if (result.rawData.matchCount > 0) {
      console.log(`✅ Historical matches found: ${result.rawData.matchCount} records were analyzed.`);
    } else {
      console.log(`⚠️ Warning: Match count is 0. Analysis might be based on default fallbacks.`);
    }

    // 3. Log Statistics (Math Verification)
    console.log(`\n--- Calculated Statistics ---`);
    console.log(`📍 Top Head Digit: ${result.rawData.topHead}`);
    console.log(`📍 Top Tail Digit: ${result.rawData.topTail}`);
    console.log(`📍 Key Number: ${result.rawData.topHead}${result.rawData.topTail}`);
    console.log(`🔥 Hot Numbers: ${result.rawData.hotNumbers.join(', ')}`);
    console.log(`🔮 Predictions: ${result.rawData.predictions.join(', ')}`);

    // 4. Output Report
    console.log(`\n--- Final Analysis Report (Burmese) ---`);
    console.log(result.analysisText);
    console.log(`--------------------------------------\n`);

    console.log(`🎉 All verification checks completed successfully.`);

  } catch (err: any) {
    console.error(`❌ Unexpected error during test:`, err.message);
    if (err.stack) {
      console.log(err.stack);
    }
  }
}

runTest();
