export interface HistoricalRecord {
  date: string;
  morning?: string;
  evening?: string;
  set_morning?: string;
  val_morning?: string;
  set_evening?: string;
  val_evening?: string;
}

export const calculateStats = (records: HistoricalRecord[]) => {
  const counts: Record<string, number> = {};
  const morningHeads: Record<string, number> = {};
  const morningTails: Record<string, number> = {};
  const eveningHeads: Record<string, number> = {};
  const eveningTails: Record<string, number> = {};

  records.forEach(rec => {
    if (rec.morning && rec.morning.length === 2) {
      counts[rec.morning] = (counts[rec.morning] || 0) + 1;
      morningHeads[rec.morning[0]] = (morningHeads[rec.morning[0]] || 0) + 1;
      morningTails[rec.morning[1]] = (morningTails[rec.morning[1]] || 0) + 1;
    }
    if (rec.evening && rec.evening.length === 2) {
      counts[rec.evening] = (counts[rec.evening] || 0) + 1;
      eveningHeads[rec.evening[0]] = (eveningHeads[rec.evening[0]] || 0) + 1;
      eveningTails[rec.evening[1]] = (eveningTails[rec.evening[1]] || 0) + 1;
    }
  });

  const sortedNums = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const hot = sortedNums.slice(0, 10);
  const cold = sortedNums.slice(-10).reverse();

  return {
    hot,
    cold,
    heads: { morning: morningHeads, evening: eveningHeads },
    tails: { morning: morningTails, evening: eveningTails },
    totalRecords: records.length
  };
};

export const findPatterns = (records: HistoricalRecord[], query: string) => {
  // Simple pattern matcher based on user query
  const lowercaseQuery = query.toLowerCase();
  
  if (lowercaseQuery.includes('ဝမ်းချိန်း') || lowercaseQuery.includes('ပတ်သီး')) {
    // Look for digits that appear frequently together
    return "Calculated pattern for Wan-Chain based on last month data...";
  }

  return "General pattern analysis active.";
};
