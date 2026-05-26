import { initializeApp } from 'firebase/app';
import { getFirestore, collection, query, where, getDocs, orderBy } from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json' assert { type: 'json' };

// Initialize Firebase (Assuming client SDK is used on server for simplicity in this applet)
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

/**
 * Pure statistical Pattern Study Function for 2D Lottery
 * Analyzes historical trends without AI intervention.
 */
export async function analyzeLotteryPatterns(targetDate: string) {
  try {
    const target = new Date(targetDate);
    if (isNaN(target.getTime())) {
      throw new Error('Invalid target date format. Use YYYY-MM-DD.');
    }

    const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const myanmarWeekdays: Record<string, string> = {
      'Sunday': 'တနင်္ဂနွေ',
      'Monday': 'တနင်္လာ',
      'Tuesday': 'အင်္ဂါ',
      'Wednesday': 'ဗုဒ္ဓဟူး',
      'Thursday': 'ကြာသပတေး',
      'Friday': 'သောကြာ',
      'Saturday': 'စနေ'
    };

    const dayName = weekdays[target.getDay()];
    const myanmarDay = myanmarWeekdays[dayName];
    const targetDayOfWeek = target.getDay();

    // 1. Fetch historical data in range
    const historyRef = collection(db, 'twod_history');
    const q = query(
      historyRef,
      where('date', '>=', '2025-01-01'),
      where('date', '<=', '2026-05-22'),
      orderBy('date', 'desc')
    );

    const snapshot = await getDocs(q);
    const records: any[] = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      const recDate = new Date(data.date);
      // Filter by same day of the week
      if (recDate.getDay() === targetDayOfWeek) {
        records.push(data);
      }
    });

    if (records.length === 0) {
      return {
        success: false,
        message: 'No historical records found for this day of the week in the specified range.'
      };
    }

    // 2. Frequency Analysis
    const numFreq: Record<string, number> = {};
    const headFreq: Record<string, number> = {};
    const tailFreq: Record<string, number> = {};

    const extractNum = (val: any): string | null => {
      if (!val) return null;
      if (typeof val === 'string') return val;
      if (val.number) return val.number;
      return null;
    };

    records.forEach(rec => {
      const morning = extractNum(rec.morning);
      const evening = extractNum(rec.evening);

      [morning, evening].forEach(num => {
        if (num && num.length === 2) {
          numFreq[num] = (numFreq[num] || 0) + 1;
          headFreq[num[0]] = (headFreq[num[0]] || 0) + 1;
          tailFreq[num[1]] = (tailFreq[num[1]] || 0) + 1;
        }
      });
    });

    // 3. Sorting & Top Picks
    const sortedHeads = Object.entries(headFreq).sort((a, b) => b[1] - a[1]);
    const sortedTails = Object.entries(tailFreq).sort((a, b) => b[1] - a[1]);
    const sortedNums = Object.entries(numFreq).sort((a, b) => b[1] - a[1]);

    const topHead = sortedHeads[0]?.[0] || '0';
    const topTail = sortedTails[0]?.[0] || '0';
    const hotNumbers = sortedNums.slice(0, 5).map(n => n[0]);

    // 4. Pattern Predictions
    // Logic: Combine top head, top tail and variations
    const predictions = [
      `${topHead}${topTail}`,
      `${topTail}${topHead}`,
      `${topHead}${topHead}`,
      `${topTail}${topTail}`,
      sortedNums[0]?.[0] || '00' // Current absolute champ
    ];

    // Remove duplicates and ensure 5 numbers
    const uniquePredictions = Array.from(new Set(predictions)).slice(0, 5);
    while (uniquePredictions.length < 5) {
      // Fallback to top numbers if variations weren't enough
      const nextHot = sortedNums.find(n => !uniquePredictions.includes(n[0]));
      if (nextHot) uniquePredictions.push(nextHot[0]);
      else uniquePredictions.push('11'); // Last resort
    }

    const keyNumber = `${topHead}${topTail}`;

    // 5. Build Burmese Report
    const analysisText = `
📊 **၂လုံးထီ ပုံစံတူ လေ့လာရေး အစီရင်ခံစာ** 📊
------------------------------------------
🎯 **ခန့်မှန်းရက်စွဲ:** ${targetDate} (${myanmarDay})

📅 **သမိုင်းကြောင်း တူညီမှု လေ့လာချက်:**
- တူညီသော ${myanmarDay}နေ့ပေါင်း (${records.length}) ရက် ရှာဖွေတွေ့ရှိခဲ့သည်။
- အထွက်အများဆုံး ထိပ်စီးဂဏန်း: (${topHead})
- အထွက်အများဆုံး နောက်ပိတ်ဂဏန်း: (${topTail})

💡 **အဓိက ဂဏန်းများနှင့် ပုံစံတူ ခန့်မှန်းချက်:**
- အဓိက ဂဏန်း (Key): **${keyNumber}**
- ခန့်မှန်းချက် ပုံစံတူ (၅) ကွက်: [ ${uniquePredictions.join(', ')} ]

🔥 **သမိုင်းတစ်လျှောက် အထွက်အများဆုံး Hot (၅) ကွက်:**
- [ ${hotNumbers.join(', ')} ]

------------------------------------------
*မှတ်ချက် - ဤအစီရင်ခံစာသည် သမိုင်းကြောင်း အချက်အလက်များအပေါ် အခြေခံထားသော သင်္ချာနည်းကျ တွက်ချက်မှုသာ ဖြစ်ပါသည်။*
    `.trim();

    return {
      success: true,
      targetDate,
      dayOfWeek: dayName,
      myanmarDay,
      analysisText,
      rawData: {
        matchCount: records.length,
        topHead,
        topTail,
        hotNumbers,
        predictions: uniquePredictions,
        frequencies: {
          heads: headFreq,
          tails: tailFreq,
          numbers: numFreq
        }
      }
    };

  } catch (error: any) {
    console.error('Lottery Analysis Error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}
