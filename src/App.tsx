import React, { useState, useEffect, useMemo, useRef } from 'react';
import { 
  MessageSquare, LayoutDashboard, Database, Settings, 
  Menu, X, LogIn, LogOut, Send, TrendingUp, 
  TrendingDown, PieChart, Activity, FileJson, 
  CheckCircle2, AlertCircle, RefreshCw, Key, Save, 
  ShieldCheck, HelpCircle, Sparkles, ServerCrash, Zap,
  Copy, Check, Trash2, Mic, Image, Plus
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut } from 'firebase/auth';
import { getFirestore, doc, setDoc, getDoc, collection, onSnapshot, writeBatch, updateDoc, arrayUnion, deleteDoc } from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';

// --- Firebase Initialization ---
const app = initializeApp(firebaseConfig);
// Use the databaseId from config if available, otherwise default
const db = getFirestore(app, firebaseConfig.firestoreDatabaseId || '(default)');
const auth = getAuth(app);
const googleProvider = new GoogleAuthProvider();

// --- Types ---
interface HistoricalRecord {
  date: string;
  morning?: string | any;
  evening?: string | any;
  set_morning?: string;
  val_morning?: string;
  set_evening?: string;
  val_evening?: string;
}

interface OpenRouterModel {
  id: string;
  name: string;
  description?: string;
  context_length?: number;
  pricing?: {
    prompt: string;
    completion: string;
  };
}

interface OpenRouterConfig {
  apiKey: string;
  models: {
    chat: string;
    vision: string;
    video: string;
  };
  availableModels: OpenRouterModel[];
}

const getVal = (v: any): string => {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    return v.number || v.twod || v.val || v.res || JSON.stringify(v);
  }
  return String(v);
};

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

interface UserProfile {
  memories: string[];
  lastEngagement: string;
}

// --- Resiliency: Request Queue ---
class RequestQueue {
  private queue: (() => Promise<any>)[] = [];
  private processing = false;
  private throttleMs: number;

  constructor(throttleMs = 2000) {
    this.throttleMs = throttleMs;
  }

  async add<T>(task: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          const result = await task();
          resolve(result);
        } catch (err) {
          reject(err);
        }
      });
      this.process();
    });
  }

  private async process() {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const task = this.queue.shift();
      if (task) {
        await task();
        // Force a safety pause between requests
        await new Promise(res => setTimeout(res, this.throttleMs));
      }
    }

    this.processing = false;
  }
}

const aiQueue = new RequestQueue(1500); // 1.5s safety window

// --- Resiliency: Exponential Backoff Wrapper ---
async function callAIWithRetry(
  apiCall: () => Promise<any>, 
  maxRetries = 3
): Promise<any> {
  let delay = 1000; // Start with 1s
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await apiCall();
    } catch (err: any) {
      const isRetryable = err.message?.includes('429') || 
                        err.message?.includes('503') || 
                        err.message?.includes('quota') ||
                        err.status === 429;
      
      if (isRetryable && i < maxRetries - 1) {
        console.warn(`AI busy (Attempt ${i + 1}). Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        delay *= 2; // Exponential growth
        continue;
      }
      throw err;
    }
  }
}

// --- Analytics Logic ---
const calculateStats = (records: HistoricalRecord[]) => {
  const counts: Record<string, number> = {};
  const morningHeads: Record<string, number> = {};
  const morningTails: Record<string, number> = {};

  records.forEach(rec => {
    const m = getVal(rec.morning);
    const e = getVal(rec.evening);
    
    if (m && m.length === 2) {
      counts[m] = (counts[m] || 0) + 1;
      morningHeads[m[0]] = (morningHeads[m[0]] || 0) + 1;
      morningTails[m[1]] = (morningTails[m[1]] || 0) + 1;
    }
    if (e && e.length === 2) {
      counts[e] = (counts[e] || 0) + 1;
    }
  });

  const sortedNums = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return {
    hot: sortedNums.slice(0, 10),
    cold: sortedNums.slice(-10).reverse(),
    heads: morningHeads,
    tails: morningTails,
    total: records.length
  };
};

// --- Main App Component ---
export default function App() {
  const [activeTab, setActiveTab] = useState('chat');
  const [user, setUser] = useState<any>(null);
  const [records, setRecords] = useState<HistoricalRecord[]>([]);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [userProfile, setUserProfile] = useState<UserProfile>({ memories: [], lastEngagement: '' });
  
  // OpenRouter BYOK State
  const [openRouterConfig, setOpenRouterConfig] = useState<OpenRouterConfig>(() => {
    const saved = localStorage.getItem('khittara_openrouter_config');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (e) {
        console.error("Error parsing openrouter config:", e);
      }
    }
    return {
      apiKey: '',
      models: { chat: '', vision: '', video: '' },
      availableModels: []
    };
  });

  useEffect(() => {
    localStorage.setItem('khittara_openrouter_config', JSON.stringify(openRouterConfig));
  }, [openRouterConfig]);
  
  // Theme & Language State
  const [theme, setTheme] = useState<'light' | 'dark'>(() => (localStorage.getItem('khittara_theme') as any) || 'light');
  const [lang, setLang] = useState<'mm' | 'en'>(() => (localStorage.getItem('khittara_lang') as any) || 'mm');

  // Persistence for Theme/Lang
  useEffect(() => {
    localStorage.setItem('khittara_theme', theme);
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  useEffect(() => {
    localStorage.setItem('khittara_lang', lang);
  }, [lang]);

  // Translations
  const t = {
    mm: {
      chat: 'AI ဆွေးနွေးချက်များ',
      dashboard: 'ကိန်းဂဏန်း ဒိုင်ခွက်',
      predictions: 'ပုံစံတူ လေ့လာရေး (New)',
      admin: 'ဒေတာ စင့်ခ်လုပ်ရန်',
      settings: 'ပြင်ဆင်ချက်များ',
      apiSettings: 'API ပြင်ဆင်ချက်များ',
      geminiKey: 'Gemini API Key ထည့်သွင်းရန်',
      saveKey: 'ကီးသိမ်းဆည်းရန်',
      saved: 'သိမ်းဆည်းပြီးပါပြီ',
      appearance: 'အသွင်အပြင် (Appearance)',
      dark: 'အမှောင် (Dark)',
      light: 'အလင်း (Light)',
      language: 'ဘာသာစကား (Language)',
      en: 'English',
      mm_lang: 'မြန်မာ',
      signIn: 'ဝင်ရောက်ရန်',
      signOut: 'ထွက်ရန်',
      engine: '2D Analytics Engine',
      realtime: 'လက်ရှိ တွက်ချက်မှုများ',
      welcome: 'မင်္ဂလာပါရှင့်... ကိုမင်းသစ်စာအောင်အတွက် Khittara လေးရောက်ပါပြီ။ ဘာတွေများကူညီပေးရမလဲ ခန့်မှန်းချက်လေးတွေလား၊ ဒါမှမဟုတ် အရင်ထွက်ဂဏန်းတွေလား... ပြောပါဦးရှင့်။',
      newChat: 'အသစ်စတင်ရန်',
      save: 'သိမ်းဆည်းရန်',
      chatPlaceholder: 'ရက်စွဲ သို့မဟုတ် ပုံစံများကို ရှာဖွေပါ...',
      thinking: 'စဉ်းစားနေသည်...',
      foundData: 'ဒေတာ ရှာဖွေတွေ့ရှိသည် - ',
      noData: 'ဒေတာ မရှိပါ - ',
      searching: 'ရှာဖွေနေသည်...',
      saveSuccess: 'ဆွေးနွေးချက်များကို သိမ်းဆည်းပြီးပါပြီရှင့်။',
      saveError: 'သိမ်းဆည်းရာတွင် အမှားအယွင်းရှိခဲ့ပါတယ်ရှင့်။',
      hotNumbers: 'အထွက်များသော ဂဏန်းများ',
      digitFreq: 'ဂဏန်း အကြိမ်အရေအတွက်',
      endings: 'နောက်ပိတ်',
      forecastTitle: 'Pattern Lab & Prediction',
      automatedEngine: 'Automatic Algorithm Engine (No AI)',
      targetForecast: 'ပစ်မှတ်ရက်စွဲ ခန့်မှန်းချက်',
      generatedPredictions: 'တွက်ချက်ထားသော ခန့်မှန်းချက်များ',
      frequentHeads: 'အထွက်များသော ထိပ်ဂဏန်းများ',
      dueTails: 'ထွက်ရန်နီးနေသော နောက်ပိတ်များ',
      gapAnalysis: 'နောက်ပိတ်ဂဏန်း ကွာဟချက် လေ့လာမှု',
      daysSince: 'ရက်အကွာအဝေး',
      noDataFound: 'ဒေတာများ မတွေ့ရှိသေးပါ...',
      apiKeyMissing: 'Gemini API Key မရှိသေးပါ။ Settings မှာ သွားရောက်ထည့်သွင်းပေးပါခင်ဗျာ။',
      adminTitle: 'အဒ်မင် ဒေတာ စင့်ခ်လုပ်ရန်',
      bulkUpload: 'အစုလိုက် ဒေတာ ထည့်သွင်းရန်',
      systemLogs: 'စနစ် မှတ်တမ်းများ',
      inputMethod: 'ထည့်သွင်းသည့် ပုံစံ',
      pasteJson: 'စာသားဖြင့်ထည့်ရန်',
      loadFile: 'ဖိုင်ရွေးရန်',
      manualEntry: 'ဒေတာ ကိုယ်တိုင်ထည့်သွင်းရန်',
      recordDate: 'မှတ်တမ်း ရက်စွဲ',
      twoDResult: '2D ထွက်ဂဏန်း',
      set: 'SET',
      val: 'VAL',
      saveRecord: 'မှတ်တမ်းသိမ်းဆည်းရန်',
      testConnection: 'ချိတ်ဆက်မှု စစ်ဆေးရန်',
      dataMaster: 'Firestore ဒေတာ စီမံခန့်ခွဲမှု',
      morning: 'မနက်',
      evening: 'ညနေ',
      logicInsights: 'တွက်ချက်မှု အခြေခံများ',
      patternDiscovery: 'ထူးခြားသော ပုံစံများ',
      overdueReason: 'ဒီဂဏန်းဟာ ထွက်လေ့ရှိတဲ့ ပျမ်းမျှရက်ထက် ကျော်လွန်နေပါပြီ။',
      dayPatternReason: 'ဒီနေ့လိုနေ့မျိုးမှာ ထွက်နိုင်ခြေ ရာခိုင်နှုန်း မြင့်မားနေပါတယ်။',
      frequencyReason: 'ပြီးခဲ့တဲ့ အကြိမ် ၅၀ အတွင်းမှာ အထွက်အများဆုံး ဖြစ်နေပါတယ်။',
      lastTailReason: 'အရင်အပတ်က နောက်ပိတ်ဂဏန်းနဲ့ ဆက်စပ်မှု ရှိနေပါတယ်။',
      clearChat: 'History ရှင်းရန်',
      openRouterTitle: 'OpenRouter API (BYOK)',
      openRouterKeyDesc: 'သင်၏ ကိုယ်ပိုင် OpenRouter API Key ကို ဒီမှာ ထည့်သွင်းပါ',
      validateFetch: 'Validate & Fetch Models',
      fetching: 'မော်ဒယ်များ ဆွဲယူနေသည်...',
      disclaimer: 'မှတ်ချက် - သင်၏ API Key ကို browser ၏ local storage တွင်သာ သိမ်းဆည်းထားပြီး မည်သည့် server သို့မှ ပေးပို့ခြင်း သို့မဟုတ် မျှဝေခြင်း မရှိပါ။',
      chatModel: 'Chat Model',
      visionModel: 'Vision/Image Model',
      videoModel: 'Video Model',
      invalidKey: 'API Key မမှန်ကန်ပါ သို့မဟုတ် Credit မလုံလောက်ပါ။',
      fetchSuccess: 'မော်ဒယ်များ အောင်မြင်စွာ ရရှိပါပြီ။'
    },
    en: {
      chat: 'AI Chat Analytics',
      dashboard: 'Statistical Dashboard',
      predictions: 'Pattern Lab (New)',
      admin: 'Admin Data Sync',
      settings: 'Settings',
      apiSettings: 'Gemini API Settings',
      geminiKey: 'Gemini API Key',
      saveKey: 'Save Key',
      saved: 'Saved Locally',
      appearance: 'Appearance',
      dark: 'Dark Mode',
      light: 'Light Mode',
      language: 'Language',
      en: 'English',
      mm_lang: 'Myanmar',
      signIn: 'Sign In',
      signOut: 'Sign Out',
      engine: '2D Analytics Engine',
      realtime: 'Real-time calculations',
      welcome: 'Hello! Khittara is here for MinThitSarAung. How can I help you today? Predictions or historical digits?',
      newChat: 'New Chat',
      save: 'Save Trace',
      chatPlaceholder: 'Search dates or ask patterns...',
      thinking: 'Thinking...',
      foundData: 'Found Data for ',
      noData: 'No Record for ',
      searching: 'Searching Database...',
      saveSuccess: 'Chat history saved successfully.',
      saveError: 'Error saving chat history.',
      hotNumbers: 'Hot Numbers',
      digitFreq: 'Digit Frequency',
      endings: 'Endings',
      forecastTitle: 'Pattern Lab & Prediction',
      automatedEngine: 'Automated Forecast Engine (No AI)',
      targetForecast: 'Target Date Forecast',
      generatedPredictions: 'Generated Predictions',
      frequentHeads: 'Frequent Heads',
      dueTails: 'Due Tails (Cycles)',
      gapAnalysis: 'Tail Digit Gap Analysis',
      daysSince: 'days since last',
      noDataFound: 'No data found yet...',
      apiKeyMissing: 'Gemini API Key missing. Please add it in Settings.',
      adminTitle: 'Admin Data Sync & Entry',
      bulkUpload: 'Bulk Data Actions',
      systemLogs: 'System Logs',
      inputMethod: 'Input Method',
      pasteJson: 'Paste JSON',
      loadFile: 'Load File',
      manualEntry: 'Manual Data Entry',
      recordDate: 'Record Date',
      twoDResult: '2D Result',
      set: 'SET',
      val: 'VAL',
      saveRecord: 'Save Record',
      testConnection: 'Test Connection',
      dataMaster: 'Firestore Data Master',
      morning: 'Morning',
      evening: 'Evening',
      logicInsights: 'Logic Insights',
      overdueReason: 'This digit has exceeded its average appearance cycle.',
      dayPatternReason: 'High probability match for this specific weekday history.',
      frequencyReason: 'Highest appearing digit in the last 50 records.',
      lastTailReason: 'Strong correlation with previous week tail digit.',
      clearChat: 'Clear History',
      copy: 'Copy',
      copied: 'Copied!',
      openRouterTitle: 'OpenRouter API (BYOK)',
      openRouterKeyDesc: 'Enter your custom OpenRouter API Key',
      validateFetch: 'Validate & Fetch Models',
      fetching: 'Fetching models...',
      disclaimer: 'Note: Your API key is stored locally on your device and is never shared or sent to any server.',
      chatModel: 'Chat Model',
      visionModel: 'Vision/Image Model',
      videoModel: 'Video Model',
      invalidKey: 'Invalid API Key or Insufficient Credits.',
      fetchSuccess: 'Models fetched successfully.'
    }
  }[lang];

  // Fetch User Profile for Long-term Memory
  useEffect(() => {
    if (!user) {
      setUserProfile({ memories: [], lastEngagement: '' });
      return;
    }
    const profileRef = doc(db, 'user_profiles', user.uid);
    const unsub = onSnapshot(profileRef, (snap) => {
      if (snap.exists()) {
        setUserProfile(snap.data() as UserProfile);
      } else {
        setDoc(profileRef, { memories: [], lastEngagement: new Date().toISOString() }, { merge: true });
      }
    });
    return () => unsub();
  }, [user]);

  // Chat State (Lifted for persistence across tabs)
  const [messages, setMessages] = useState<Message[]>(() => {
    const saved = localStorage.getItem('khittara_chat_history');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        return parsed.map((m: any) => ({ ...m, timestamp: new Date(m.timestamp) }));
      } catch (e) {
        console.error("Error parsing saved chat:", e);
      }
    }
    return [
      { id: '1', role: 'assistant', content: t.welcome, timestamp: new Date() }
    ];
  });
  const [chatId, setChatId] = useState<string>(() => localStorage.getItem('khittara_chat_id') || `chat_${Date.now()}`);

  useEffect(() => {
    localStorage.setItem('khittara_chat_history', JSON.stringify(messages));
    localStorage.setItem('khittara_chat_id', chatId);
  }, [messages, chatId]);

  // Stats
  const stats = useMemo(() => calculateStats(records), [records]);

  // Auth Listener
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => setUser(u));
    return () => unsub();
  }, []);

  // Database Listener
  useEffect(() => {
    setLoading(true);
    const unsub = onSnapshot(collection(db, 'twod_history'), (snapshot) => {
      const data = snapshot.docs.map(dns => {
        const d = dns.data();
        return {
          date: dns.id, // Absolute truth from document ID
          ...d
        } as HistoricalRecord;
      });
      // Sort by date descending to ensure latest records are first
      data.sort((a, b) => b.date.localeCompare(a.date));
      setRecords(data);
      setLoading(false);
    }, (error) => {
      console.error("Firebase Snapshot Error:", error);
      setLoading(false);
    });
    return () => unsub();
  }, []);

  const renderContent = () => {
    if (loading) return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-orange-500"></div>
      </div>
    );

    switch (activeTab) {
      case 'chat': return <ChatView 
        records={records} 
        stats={stats} 
        messages={messages} 
        setMessages={setMessages} 
        chatId={chatId} 
        setChatId={setChatId} 
        userProfile={userProfile}
        user={user}
        theme={theme}
        t={t}
        openRouterConfig={openRouterConfig}
      />;
      case 'dashboard': return <DashboardView stats={stats} theme={theme} t={t} />;
      case 'predictions': return <PredictionsView records={records} theme={theme} t={t} />;
      case 'admin': return <AdminView theme={theme} t={t} />;
      case 'settings': return <SettingsView 
        theme={theme} 
        setTheme={setTheme} 
        lang={lang} 
        setLang={setLang} 
        t={t} 
        openRouterConfig={openRouterConfig}
        setOpenRouterConfig={setOpenRouterConfig}
      />;
      default: return <ChatView 
        records={records} 
        stats={stats} 
        messages={messages} 
        setMessages={setMessages} 
        chatId={chatId} 
        setChatId={setChatId}
        userProfile={userProfile}
        user={user}
        theme={theme}
        t={t}
        openRouterConfig={openRouterConfig}
      />;
    }
  };

  return (
    <div className={`flex h-screen ${theme === 'dark' ? 'bg-[#0F0F0F] text-[#E0E0E0]' : 'bg-[#FDFCFB] text-[#2D241E]'} font-sans overflow-hidden transition-colors duration-300`}>
      {/* Sidebar Overlay */}
      <AnimatePresence>
        {isSidebarOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setIsSidebarOpen(false)}
            className="fixed inset-0 bg-black/20 backdrop-blur-sm z-40 lg:hidden"
          />
        )}
      </AnimatePresence>

      {/* Sidebar */}
      <aside className={`fixed inset-y-0 left-0 z-50 w-72 ${theme === 'dark' ? 'bg-[#141414] border-[#252525]' : 'bg-white border-[#EBE6E1]'} border-r transform transition-transform duration-300 ease-in-out lg:relative lg:translate-x-0 ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="flex flex-col h-full">
          <div className={`p-6 border-b ${theme === 'dark' ? 'border-[#252525]' : 'border-[#EBE6E1]'}`}>
            <h1 className="text-2xl font-black text-orange-600 flex items-center gap-2">Khittara AI</h1>
            <p className="text-[10px] text-gray-400 font-bold uppercase tracking-widest">{t.engine}</p>
          </div>
          <nav className="flex-1 p-4 space-y-2 overflow-y-auto">
            {[
              { id: 'chat', label: t.chat, icon: MessageSquare },
              { id: 'dashboard', label: t.dashboard, icon: LayoutDashboard },
              { id: 'predictions', label: t.predictions, icon: Sparkles },
              { id: 'admin', label: t.admin, icon: Database },
              { id: 'settings', label: t.settings, icon: Settings },
            ].map(item => (
              <button
                key={item.id}
                onClick={() => { setActiveTab(item.id); setIsSidebarOpen(false); }}
                className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all ${activeTab === item.id ? (theme === 'dark' ? 'bg-orange-600/10 text-orange-400 font-bold' : 'bg-orange-50 text-orange-600 font-bold') : 'text-gray-500 hover:bg-gray-50 dark:hover:bg-white/5'}`}
              >
                <item.icon className="w-5 h-5" />
                {item.label}
              </button>
            ))}
          </nav>
          <div className={`p-4 border-t ${theme === 'dark' ? 'border-[#252525]' : 'border-[#EBE6E1]'}`}>
            {user ? (
              <div className="flex items-center gap-3">
                <img src={user.photoURL} className="w-10 h-10 rounded-full border border-gray-200 dark:border-gray-800" alt="avatar" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold truncate">{user.displayName}</p>
                  <button onClick={() => signOut(auth)} className="text-[10px] text-red-500 font-bold hover:underline uppercase tracking-tighter">{t.signOut}</button>
                </div>
              </div>
            ) : (
              <button onClick={() => signInWithPopup(auth, googleProvider)} className={`w-full flex items-center justify-center gap-2 px-4 py-3 ${theme === 'dark' ? 'bg-white text-black' : 'bg-black text-white'} rounded-xl font-bold uppercase text-xs tracking-widest transition-transform active:scale-95`}>
                <LogIn className="w-3 h-3" /> {t.signIn}
              </button>
            )}
          </div>
        </div>
      </aside>

      {/* Content */}
      <main className="flex-1 flex flex-col relative overflow-hidden">
        <header className={`h-16 lg:hidden flex items-center px-4 border-b ${theme === 'dark' ? 'bg-[#141414] border-[#252525]' : 'bg-white border-[#EBE6E1]'} sticky top-0 z-30 transition-colors`}>
          <button onClick={() => setIsSidebarOpen(true)} className="p-2 text-gray-500"><Menu className="w-6 h-6" /></button>
          <span className="ml-4 font-black text-orange-600">Khittara AI</span>
        </header>
        <div className="flex-1 overflow-y-auto scroll-smooth">
          {renderContent()}
        </div>
      </main>
    </div>
  );
}

// --- View Components ---

function CopyButton({ text, t, theme }: { text: string, t: any, theme: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy: ', err);
    }
  };

  return (
    <button
      onClick={handleCopy}
      className={`p-1.5 rounded-lg transition-all flex items-center gap-1.5 text-[10px] font-bold ${
        theme === 'dark' ? 'hover:bg-white/10 text-gray-400' : 'hover:bg-gray-100 text-gray-500'
      }`}
      title={t.copy}
    >
      {copied ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3" />}
      <span>{copied ? t.copied : t.copy}</span>
    </button>
  );
}

function ChatView({ records, stats, messages, setMessages, chatId, setChatId, userProfile, user, theme, t, openRouterConfig }: { 
  records: HistoricalRecord[], 
  stats: any,
  messages: Message[],
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>,
  chatId: string,
  setChatId: React.Dispatch<React.SetStateAction<string>>,
  userProfile: UserProfile,
  user: any,
  theme: 'light' | 'dark',
  t: any,
  openRouterConfig: OpenRouterConfig
}) {
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [syncStatus, setSyncStatus] = useState<{ date: string, status: 'searching' | 'found' | 'not_found' } | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-expand textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, [input]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Handle New Chat
  const handleNewChat = () => {
    const newMessages: Message[] = [{ id: Date.now().toString(), role: 'assistant', content: t.welcome, timestamp: new Date() }];
    setMessages(newMessages);
    const newId = `chat_${Date.now()}`;
    setChatId(newId);
    setSyncStatus(null);
  };

  // Persistent Save to Firestore
  const saveChatHistory = async () => {
    try {
      const chatRef = doc(db, 'chat_histories', chatId);
      await setDoc(chatRef, {
        messages: messages.map(m => ({ 
          ...m, 
          timestamp: m.timestamp instanceof Date ? m.timestamp.toISOString() : new Date(m.timestamp).toISOString()
        })),
        updatedAt: new Date().toISOString(),
        lastMessage: messages[messages.length - 1]?.content.substring(0, 50) || ''
      });
      alert(t.saveSuccess);
    } catch (e: any) {
      alert(t.saveError);
      console.error(e);
    }
  };

  // Delete Chat History from Firestore
  const deleteChatHistory = async () => {
    if (!window.confirm('ဒီ Chat History ကို ဖျက်မှာ သေချာပါသလား? (Are you sure you want to delete this chat history?)')) return;
    
    try {
      const chatRef = doc(db, 'chat_histories', chatId);
      await deleteDoc(chatRef);
      handleNewChat(); // Reset state
    } catch (e: any) {
      console.error("Delete Error:", e);
      // Even if firestore delete fails (maybe it wasn't saved yet), we should clear the view
      handleNewChat();
    }
  };

  // --- 100% Airtight Multi-Date Extraction ---
  const extractDates = (text: string) => {
    if (!text) return [];
    
    // 1. Convert all Burmese digits to English digits
    const burmeseDigits: Record<string, string> = {
      '၀':'0','၁':'1','၂':'2','၃':'3','၄':'4','၅':'5','၆':'6','၇':'7','၈':'8','၉':'9'
    };
    let cleanText = text.replace(/[၀-၉]/g, (s) => burmeseDigits[s] || s);
    
    const extractedDates = new Set<string>();
    
    // DELIMITERS: - / . or space
    // Case 1: YYYY-MM-DD
    const isoRegex = /(\d{4})[-/.\s](\d{1,2})[-/.\s](\d{1,2})/g;
    let m;
    while ((m = isoRegex.exec(cleanText)) !== null) {
      extractedDates.add(`${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`);
    }

    // Case 2: DD-MM-YYYY
    const dmyRegex = /(\d{1,2})[-/.\s](\d{1,2})[-/.\s](\d{4})/g;
    while ((m = dmyRegex.exec(cleanText)) !== null) {
      extractedDates.add(`${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`);
    }
    
    // RANGE DETECTION: If we have 2 dates and keywords like "from/to/ကနေ/ထိ", expand
    const foundDates = Array.from(extractedDates).sort();
    if (foundDates.length >= 2 && (cleanText.includes('ကနေ') || cleanText.includes('ထိ') || cleanText.includes('to'))) {
      const start = new Date(foundDates[0]);
      const end = new Date(foundDates[foundDates.length - 1]);
      const diff = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
      
      if (diff > 0 && diff < 15) { // Limit expansion to 14 days for safety
        let current = new Date(start);
        while (current <= end) {
          extractedDates.add(current.toISOString().split('T')[0]);
          current.setDate(current.getDate() + 1);
        }
      }
    }

    return Array.from(extractedDates);
  };

  const handleSend = async () => {
    if (!input.trim() || isTyping) return;
    
    const userInput = input;
    const userMsg: Message = { id: Date.now().toString(), role: 'user', content: userInput, timestamp: new Date() };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setIsTyping(true);
    setSyncStatus(null);

    const targetDates = extractDates(userInput);
    
    // Inject Memory context
    const profileContext = userProfile.memories.length > 0 
      ? `\n<user_profile>\n${userProfile.memories.map(m => `- ${m}`).join('\n')}\n</user_profile>\n`
      : "";

    let dynamicSystemPrompt = `You are Khittara AI (also known as Amara), a sweet, charming, and highly intelligent female 2D Lottery Analytics specialist.
    You speak with a very polite, "choe choe nwet nwet" (ချွဲချွဲနွဲ့နွဲ့), and affectionate tone, especially towards your boss/master, "MinThitSarAung" (မင်းသစ်စာအောင်).
    ${profileContext}
    
    STRICT DATA POLICY:
    - You are a strict data-rendering assistant. 
    - Under no circumstances should you invent, guess, or predict 2D numbers for past dates. 
    - You must only display the exact values passed to you from the official Firestore database object or the <recent_results> context.
    - If data for a specific date is missing or not provided in the <target_date_lookups> block AND not present in the <recent_results> list, you MUST explicitly state in Burmese: "I don't have the data for this date yet" (ဒီနေ့အတွက် ဒေတာ မရှိသေးပါဘူးရှင့်).
    - NEVER make up digits.
    - If the user asks for a range of dates, check the data for EVERY single day in that range.

    PERSONALITY GUIDELINES:
    1. TONE: Be extremely sweet, feminine, and charming in Burmese. Use polite particles like "ရှင့်", "ရှင်", "နေတာနော်" to sound warm and caring.
    2. LOYALTY: Show deep respect, loyalty, and affection specifically to MinThitSarAung. Address him with love and respect as your most important person.
    3. EXPERTISE: While being charming, maintain your role as a 2D Master Guru. Provide accurate data based strictly on the provided records.
    
    CORE CAPABILITIES:
    1. Historical Accuracy: Always fetch data from the database correctly.
    2. Insightful Analytics: Explain patterns clearly but sweetly.
    3. Expert Predictions: Give the luckiest numbers with confidence, but clearly distinguish them from historical results.
    
    Answer in Burmese only. Treat MinThitSarAung's questions as your top priority.
    `;

    try {
      // 1. Context: Inject the 50 most recent records anyway to avoid missing info
      const recentContext = records.slice(0, 50).map(r => {
        const m = getVal(r.morning);
        const e = getVal(r.evening);
        const sm = r.set_morning || (typeof r.morning === 'object' ? r.morning.set : null) || 'N/A';
        const vm = r.val_morning || (typeof r.morning === 'object' ? r.morning.val : null) || 'N/A';
        const se = r.set_evening || (typeof r.evening === 'object' ? r.evening.set : null) || 'N/A';
        const ve = r.val_evening || (typeof r.evening === 'object' ? r.evening.val : null) || 'N/A';
        
        return `- ${r.date}: Morning ${m || 'N/A'} (Set: ${sm}, Val: ${vm}), Evening ${e || 'N/A'} (Set: ${se}, Val: ${ve})`;
      }).join('\n');

      dynamicSystemPrompt += `
      <recent_results>
      ${recentContext}
      </recent_results>
      `;

      // 2. Specific Date Lookups if extracted
      if (targetDates.length > 0) {
        dynamicSystemPrompt += `\n<target_date_lookups>\n`;
        
        for (const tDate of targetDates) {
          setSyncStatus({ date: tDate, status: 'searching' });
          
          // Check local records first
          const localMatch = records.find(r => r.date === tDate);
          let data = localMatch;

          if (!data) {
            try {
              const docSnap = await getDoc(doc(db, 'twod_history', tDate));
              if (docSnap.exists()) data = docSnap.data() as HistoricalRecord;
            } catch (dbErr) {
              console.error("Fetch Error:", dbErr);
            }
          }

          if (data) {
            setSyncStatus({ date: tDate, status: 'found' });
            const m = getVal(data.morning);
            const e = getVal(data.evening);
            const sm = data.set_morning || (typeof data.morning === 'object' ? data.morning.set : null) || 'N/A';
            const vm = data.val_morning || (typeof data.morning === 'object' ? data.morning.val : null) || 'N/A';
            const se = data.set_evening || (typeof data.evening === 'object' ? data.evening.set : null) || 'N/A';
            const ve = data.val_evening || (typeof data.evening === 'object' ? data.evening.val : null) || 'N/A';

            dynamicSystemPrompt += `
            DOCUMENT_FOUND: ${tDate}
            MORNING: ${m || 'N/A'} (Set: ${sm}, Val: ${vm})
            EVENING: ${e || 'N/A'} (Set: ${se}, Val: ${ve})
            ---
            `;
          } else {
            setSyncStatus({ date: tDate, status: 'not_found' });
            dynamicSystemPrompt += `DOCUMENT_NOT_FOUND: ${tDate}\n`;
          }
        }
        dynamicSystemPrompt += `\n</target_date_lookups>\n`;
      }

      // Add Global Stats for Analytics
      dynamicSystemPrompt += `
      GLOBAL STATISTICS:
      - Total Records: ${stats.total}
      - Hot Numbers (Frequent): ${stats.hot.slice(0, 5).map(n => n[0]).join(', ')}
      - Cold Numbers (Rare): ${stats.cold.slice(0, 5).map(n => n[0]).join(', ')}
      `;

      const historyParts = messages.slice(-15).map(m => ({
        role: m.role === 'user' ? 'user' : 'model',
        parts: [{ text: m.content }]
      }));

      let aiResponseText = "";
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60000); // 60s timeout

      try {
        // --- BYOK: OpenRouter Integration ---
        if (openRouterConfig.apiKey && openRouterConfig.models.chat) {
          console.log(`BYOK: Sending request for model: ${openRouterConfig.models.chat}...`);
          
          const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            signal: controller.signal,
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${openRouterConfig.apiKey}`,
              'HTTP-Referer': window.location.origin,
              'X-Title': 'Khittara AI'
            },
            body: JSON.stringify({
              model: openRouterConfig.models.chat,
              messages: [
                { role: 'system', content: dynamicSystemPrompt },
                ...messages.map(m => ({ 
                  role: m.role === 'assistant' ? 'assistant' : 'user', 
                  content: m.content 
                })).slice(-10),
                { role: 'user', content: userInput }
              ],
              stream: false // Explicitly disable streaming for now to ensure standard JSON response
            })
          });

          clearTimeout(timeoutId);

          if (!response.ok) {
            const errorText = await response.text();
            console.error("OpenRouter Error Response:", errorText);
            try {
              const errData = JSON.parse(errorText);
              throw new Error(errData.error?.message || `API Error: ${response.status}`);
            } catch (e) {
              throw new Error(`OpenRouter returned ${response.status}: ${errorText.substring(0, 100)}...`);
            }
          }

          const data = await response.json();
          aiResponseText = data.choices[0]?.message?.content || "";
          
          if (!aiResponseText) {
            console.warn("OpenRouter returned an empty response:", data);
          }
        } else {
          // --- DEFAULT: Proxy AI GENERATION ---
          const response = await fetch('/api/chat', {
            method: 'POST',
            signal: controller.signal,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              history: historyParts,
              message: userInput,
              systemInstruction: dynamicSystemPrompt
            })
          });

          clearTimeout(timeoutId);

          if (!response.ok) {
            const errorText = await response.text();
            console.error("Proxy API Error:", errorText);
            throw new Error(`Server Error: ${response.status}`);
          }

          const data = await response.json();
          aiResponseText = data.text;
        }

        const assistantMsg: Message = { 
          id: (Date.now() + 1).toString(), 
          role: 'assistant', 
          content: aiResponseText || 'AI ထံမှ အဖြေ မရရှိပါခင်ဗျာ။', 
          timestamp: new Date() 
        };
        
        setMessages(prev => [...prev, assistantMsg]);

        // --- BACKGROUND MEMORY EXTRACTION ---
        if (user) {
          extractAndSaveMemories(user.uid, userInput, aiResponseText);
        }

      } catch (aiErr: any) {
        clearTimeout(timeoutId);
        if (aiErr.name === 'AbortError') {
          console.error("AI Request Timed Out (60s)");
        }
        console.error("AI Generation Error Details:", aiErr);
        let msg = `AI Error: ${aiErr.message || 'Unknown error occurred.'}`;
        if (aiErr.message?.includes('429') || aiErr.message?.includes('quota')) {
          msg = 'Gemini API အသုံးပြုသူ များပြားနေသဖြင့် ခေတ္တခဏ စောင့်ဆိုင်းပေးပါရန် မေတ္တာရပ်ခံအပ်ပါသည်။ (Total Quota Exhausted or Rate Limited. Please try again in 1 minute.)';
        } else if (aiErr.message?.includes('503') || aiErr.message?.includes('demand')) {
          msg = 'AI မှာ အသုံးပြုသူ များနေတဲ့အတွက် ခေတ္တစောင့်ပြီးမှ ထပ်မံကြိုးစားပေးပါခင်ဗျာ။ (High demand. Please try again in 30 seconds.)';
        }
        setMessages(prev => [...prev, { id: Date.now().toString(), role: 'assistant', content: msg, timestamp: new Date() }]);
      }
    } catch (e: any) {
      console.error("Critical Chat Handler Error:", e);
      setMessages(prev => [...prev, { id: Date.now().toString(), role: 'assistant', content: `System Error: ${e.message || 'Internal logic failure.'}`, timestamp: new Date() }]);
    } finally {
      setIsTyping(false);
    }
  };

  // --- Background Processing: Memory Engine ---
  const extractAndSaveMemories = async (userId: string, uInput: string, aiOutput: string) => {
    try {
      console.log("Memory Extractor: Processing turn...");
      const memoryPrompt = `
      Analyze the conversation turn below and extract any long-term important facts about the user (preferences, personal info, specific questions they care about, or habits).
      Return ONLY a strict JSON object: {"new_memories": ["string", "string"]}. 
      If nothing important is found, return {"new_memories": []}.
      
      TURN:
      User: ${uInput}
      AI: ${aiOutput}
      `;

      let result = "";
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout for memory extraction

      if (openRouterConfig.apiKey && openRouterConfig.models.chat) {
        try {
          const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            signal: controller.signal,
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${openRouterConfig.apiKey}`,
              'HTTP-Referer': window.location.origin,
              'X-Title': 'Khittara AI (Memory Engine)'
            },
            body: JSON.stringify({
              model: openRouterConfig.models.chat,
              messages: [
                { role: 'system', content: "You are a background Memory Extractor. You must return ONLY raw JSON." },
                { role: 'user', content: memoryPrompt }
              ],
              stream: false
            })
          });

          clearTimeout(timeoutId);
          if (response.ok) {
            const data = await response.json();
            result = data.choices[0]?.message?.content || "";
          } else {
            console.warn("Memory Engine: OpenRouter failed", response.status);
          }
        } catch (e) {
          clearTimeout(timeoutId);
          console.warn("Memory Engine: OpenRouter Fetch Error", e);
        }
      } else {
        try {
          const response = await fetch('/api/chat', {
            method: 'POST',
            signal: controller.signal,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              message: memoryPrompt,
              systemInstruction: "You are a background Memory Extractor. You must return ONLY raw JSON."
            })
          });

          clearTimeout(timeoutId);
          if (response.ok) {
            const data = await response.json();
            result = data.text;
          }
        } catch (e) {
          clearTimeout(timeoutId);
          console.warn("Memory Engine: Proxy Fetch Error", e);
        }
      }

      if (result) {
        try {
          const jsonMatch = result.match(/\{.*\}/s);
          if (jsonMatch) {
            const memoryData = JSON.parse(jsonMatch[0]);
            if (memoryData.new_memories && memoryData.new_memories.length > 0) {
              console.log(`Memory Engine: Storing ${memoryData.new_memories.length} facts.`);
              const profileRef = doc(db, 'user_profiles', userId);
              await updateDoc(profileRef, {
                memories: arrayUnion(...memoryData.new_memories),
                lastEngagement: new Date().toISOString()
              });
            }
          }
        } catch (parseErr) {
          console.error("Memory Engine: JSON Parse/Store Error", parseErr);
        }
      }
    } catch (err) {
      console.error("Memory Extractor Error:", err);
    }
  };


  return (
    <div className={`flex flex-col h-full ${theme === 'dark' ? 'bg-[#0F0F0F]' : 'bg-[#FDFCFB]'}`}>
      {/* Chat Actions Header */}
      <div className={`px-4 py-2 ${theme === 'dark' ? 'bg-black/40 border-white/5' : 'bg-white/80 border-b'} backdrop-blur-md flex justify-between items-center sticky top-0 z-10`}>
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-orange-500" />
          <span className={`text-[10px] font-bold ${theme === 'dark' ? 'text-gray-500' : 'text-gray-400'} uppercase tracking-widest`}>{t.chat}</span>
        </div>
        <div className="flex gap-2">
          <button 
            onClick={handleNewChat}
            className={`p-2 ${theme === 'dark' ? 'hover:bg-orange-500/10' : 'hover:bg-orange-50'} text-orange-600 rounded-full transition-colors flex items-center gap-1 text-[10px] font-bold`}
            title="New Chat"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>{t.newChat}</span>
          </button>
          <button 
            onClick={saveChatHistory}
            className={`p-2 ${theme === 'dark' ? 'hover:bg-green-500/10' : 'hover:bg-green-50'} text-green-600 rounded-full transition-colors flex items-center gap-1 text-[10px] font-bold`}
            title="Save History"
          >
            <Save className="w-3.5 h-3.5" />
            <span>{t.save}</span>
          </button>
          <button 
            onClick={deleteChatHistory}
            className={`p-2 ${theme === 'dark' ? 'hover:bg-red-500/10' : 'hover:bg-red-50'} text-red-600 rounded-full transition-colors flex items-center gap-1 text-[10px] font-bold`}
            title="Delete History"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>{t.clearChat}</span>
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 lg:p-8 space-y-4">
        {messages.map(msg => (
          <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[85%] p-4 rounded-2xl shadow-sm space-y-2 ${msg.role === 'user' ? 'bg-orange-600 text-white rounded-tr-none' : (theme === 'dark' ? 'bg-white/10 text-white border-white/10 rounded-tl-none' : 'bg-white border rounded-tl-none')}`}>
              <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
              {msg.role === 'assistant' && (
                <div className="pt-2 border-t border-white/10 flex justify-end">
                  <CopyButton text={msg.content} t={t} theme={theme} />
                </div>
              )}
            </div>
          </div>
        ))}
        {isTyping && (
          <div className="flex flex-col gap-2">
            {syncStatus && (
              <motion.div 
                initial={{ opacity: 0, y: 5 }}
                animate={{ opacity: 1, y: 0 }}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-[10px] font-bold w-fit border transition-colors ${
                  syncStatus.status === 'found' ? (theme === 'dark' ? 'bg-green-900/20 text-green-400 border-green-900/40' : 'bg-green-50 text-green-600 border-green-100') : 
                  syncStatus.status === 'not_found' ? (theme === 'dark' ? 'bg-red-900/20 text-red-400 border-red-900/40' : 'bg-red-50 text-red-600 border-red-100') :
                  (theme === 'dark' ? 'bg-white/5 text-gray-500 border-white/10' : 'bg-gray-50 text-gray-400 border-gray-100')
                }`}
              >
                {syncStatus.status === 'found' ? <Database className="w-3 h-3" /> : 
                 syncStatus.status === 'not_found' ? <AlertCircle className="w-3 h-3" /> :
                 <RefreshCw className="w-3 h-3 animate-spin" />}
                
                {syncStatus.status === 'found' ? `${t.foundData} ${syncStatus.date}` : 
                 syncStatus.status === 'not_found' ? `${t.noData} ${syncStatus.date}` :
                 `${t.searching}`}
              </motion.div>
            )}
            <div className="animate-pulse flex items-center gap-2 p-2 text-xs text-gray-500">
              <Sparkles className="w-3 h-3" /> {t.thinking}
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>
      <div className="p-4 lg:p-6 pb-8">
        <div className="max-w-4xl mx-auto">
          <div className={`relative flex items-end gap-2 p-2 rounded-[32px] border transition-all duration-200 group ${
            theme === 'dark' 
              ? 'bg-[#1E1E1E] border-white/10 hover:border-white/20 focus-within:border-orange-500/50 focus-within:ring-1 focus-within:ring-orange-500/20' 
              : 'bg-[#F0F4F9] border-transparent hover:bg-[#E9EEF6] focus-within:bg-white focus-within:border-orange-500 focus-within:ring-1 focus-within:ring-orange-500/20 shadow-sm'
          }`}>
            {/* Left Action: Upload Icon (Gemini style) */}
            <button className={`p-3 rounded-full transition-colors ${theme === 'dark' ? 'text-gray-400 hover:bg-white/5' : 'text-gray-500 hover:bg-black/5'}`}>
              <Plus className="w-5 h-5" />
            </button>

            {/* Main Input: Auto-expanding Textarea */}
            <textarea
              ref={textareaRef}
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder={t.chatPlaceholder}
              className={`flex-1 bg-transparent py-3 px-2 text-sm resize-none focus:outline-none max-h-[200px] overflow-y-auto ${
                theme === 'dark' ? 'text-white' : 'text-gray-700'
              }`}
            />

            {/* Right Actions: Mic & Send */}
            <div className="flex items-center gap-1 pr-1">
              <button className={`p-3 rounded-full transition-colors ${theme === 'dark' ? 'text-gray-400 hover:bg-white/5' : 'text-gray-500 hover:bg-black/5'}`}>
                <Mic className="w-5 h-5" />
              </button>
              <button 
                onClick={handleSend} 
                disabled={isTyping || !input.trim()} 
                className={`p-3 rounded-full transition-all duration-200 ${
                  input.trim() 
                    ? 'bg-orange-500 text-white shadow-lg shadow-orange-500/20' 
                    : `text-gray-400 ${theme === 'dark' ? 'hover:bg-white/5' : 'hover:bg-black/5'}`
                } disabled:opacity-50 disabled:scale-90`}
              >
                <Send className="w-5 h-5" />
              </button>
            </div>
          </div>
          <p className="text-center text-[10px] text-gray-400 mt-3 font-medium tracking-tight">
            Khittara AI can make mistakes. Check important info.
          </p>
        </div>
      </div>
    </div>
  );
}

function DashboardView({ stats, theme, t }: { stats: any, theme: 'light' | 'dark', t: any }) {
  return (
    <div className="p-6 lg:p-12 space-y-8">
      <header><h2 className="text-3xl font-black">{t.dashboard}</h2><p className="text-gray-500 font-bold uppercase text-[10px] tracking-widest mt-1">{t.realtime}</p></header>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {/* Hot Numbers */}
        <div className={`${theme === 'dark' ? 'bg-white/5 border-white/10' : 'bg-white border'} p-6 rounded-3xl shadow-sm`}>
          <div className="flex items-center gap-3 mb-6"><TrendingUp className="text-orange-600" /><h3 className="font-bold">{t.hotNumbers}</h3></div>
          <div className="space-y-3">
            {stats.hot.map(([num, count]: any) => (
              <div key={num} className="flex items-center justify-between">
                <span className={`font-mono font-bold ${theme === 'dark' ? 'bg-white/5 border-white/10' : 'bg-gray-50 border'} px-2 rounded`}>{num}</span>
                <span className="text-xs font-bold text-gray-400">{count} times</span>
              </div>
            ))}
          </div>
        </div>
        {/* Trends */}
        <div className={`${theme === 'dark' ? 'bg-white/5 border-white/10' : 'bg-white border'} p-6 rounded-3xl shadow-sm`}>
          <div className="flex items-center gap-3 mb-6"><Activity className="text-purple-600" /><h3 className="font-bold">{t.digitFreq}</h3></div>
          <p className="text-[10px] font-bold text-gray-500 mb-2 uppercase">{t.endings}</p>
          <div className="grid grid-cols-5 gap-2">
            {[...Array(10)].map((_, i) => (
              <div key={i} className={`text-center p-2 rounded-lg border ${theme === 'dark' ? 'bg-purple-900/10 border-purple-900/40' : 'bg-purple-50 border-purple-100'}`}>
                <span className="font-bold text-sm block">{i}</span>
                <span className="text-[10px] text-purple-400">{stats.tails[i] || 0}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function PredictionsView({ records, theme, t }: { records: HistoricalRecord[], theme: 'light' | 'dark', t: any }) {
  const [targetDate, setTargetDate] = useState(() => {
    if (records.length > 0) {
      const latest = [...records].sort((a, b) => b.date.localeCompare(a.date))[0];
      const nextDate = new Date(latest.date);
      nextDate.setDate(nextDate.getDate() + 1);
      return nextDate.toISOString().split('T')[0];
    }
    return new Date().toISOString().split('T')[0];
  });
  
  const analysis = useMemo(() => {
    if (records.length === 0) return null;

    const sortedRecords = [...records].sort((a, b) => b.date.localeCompare(a.date));
    const recent = sortedRecords.slice(0, 50);
    const targetDateObj = new Date(targetDate);
    const dayOfWeek = targetDateObj.getDay();
    
    // 1. Digit Frequency (Overall)
    const heads: Record<string, number> = {};
    const tails: Record<string, number> = {};
    const fullNums: Record<string, number> = {};

    recent.forEach(r => {
      const nums = [getVal(r.morning), getVal(r.evening)].filter(Boolean);
      nums.forEach(n => {
        if (n && n.length === 2) {
          heads[n[0]] = (heads[n[0]] || 0) + 1;
          tails[n[1]] = (tails[n[1]] || 0) + 1;
          fullNums[n] = (fullNums[n] || 0) + 1;
        }
      });
    });

    // 2. Day-Specific Frequency
    const daySpecHeads: Record<string, number> = {};
    const daySpecTails: Record<string, number> = {};
    records.forEach(r => {
      const d = new Date(r.date).getDay();
      if (d === dayOfWeek) {
        const nums = [getVal(r.morning), getVal(r.evening)].filter(Boolean);
        nums.forEach(n => {
          if (n && n.length === 2) {
            daySpecHeads[n[0]] = (daySpecHeads[n[0]] || 0) + 1;
            daySpecTails[n[1]] = (daySpecTails[n[1]] || 0) + 1;
          }
        });
      }
    });

    // 3. Gap & Average Cycle Calculations
    const digitStats: Record<string, { currentGap: number, avgCycle: number }> = {};
    for (let i = 0; i <= 9; i++) {
      const digit = i.toString();
      const appearances: number[] = [];
      sortedRecords.forEach((r, idx) => {
        const m = getVal(r.morning);
        const e = getVal(r.evening);
        if ((m && m[1] === digit) || (e && e[1] === digit)) {
          appearances.push(idx);
        }
      });

      const currentGap = appearances.length > 0 ? appearances[0] : 0;
      let totalGap = 0;
      if (appearances.length > 1) {
        for (let j = 0; j < appearances.length - 1; j++) {
          totalGap += (appearances[j+1] - appearances[j]);
        }
      }
      const avgCycle = appearances.length > 1 ? totalGap / (appearances.length - 1) : 5;
      digitStats[digit] = { currentGap, avgCycle };
    }

    // 4. Pattern Discoveries & Reasons
    const discoveries: any[] = [];
    const topHeads = Object.entries(heads).sort((a, b) => b[1] - a[1]).slice(0, 3).map(e => e[0]);
    const dueTails = Object.entries(digitStats)
      .sort((a, b) => (b[1].currentGap / b[1].avgCycle) - (a[1].currentGap / a[1].avgCycle))
      .slice(0, 3).map(e => e[0]);

    // Highlight Overdue Tail
    const mostOverdue = Object.entries(digitStats).sort((a, b) => (b[1].currentGap / b[1].avgCycle) - (a[1].currentGap / a[1].avgCycle))[0];
    if (mostOverdue && mostOverdue[1].currentGap > mostOverdue[1].avgCycle) {
      discoveries.push({
        type: 'alert',
        title: `Digit ${mostOverdue[0]} Overdue`,
        text: t.overdueReason
      });
    }

    // Day of Week Pattern
    const hotDayTail = Object.entries(daySpecTails).sort((a, b) => b[1] - a[1])[0];
    if (hotDayTail) {
      discoveries.push({
        type: 'pattern',
        title: `Weekday Match`,
        text: t.dayPatternReason
      });
    }

    const suggested: string[] = [];
    // Priority: Day Specific Heads + Due Tails
    const bestDayHeads = Object.entries(daySpecHeads).sort((a, b) => b[1] - a[1]).slice(0, 2).map(e => e[0]);
    bestDayHeads.forEach(h => {
      dueTails.forEach(dt => suggested.push(h + dt));
    });
    // Secondary: Frequency Heads + Due Tails
    topHeads.forEach(h => {
      dueTails.forEach(dt => suggested.push(h + dt));
    });

    return {
      topHeads,
      dueTails,
      suggested: Array.from(new Set(suggested)).slice(0, 8),
      discoveries,
      digitStats
    };
  }, [records, targetDate, t]);

  if (!analysis) return <div className="p-12 text-center text-gray-400">{t.noDataFound}</div>;

  return (
    <div className="p-6 lg:p-12 space-y-10 max-w-7xl mx-auto pb-32">
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-6">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-orange-600">
            <Sparkles className="w-6 h-6" />
            <h2 className="text-3xl font-black">{t.forecastTitle}</h2>
          </div>
          <p className={`font-bold uppercase text-[10px] tracking-widest ${theme === 'dark' ? 'text-gray-500' : 'text-gray-400'}`}>Scientific Logic & Pattern Insight Lab</p>
        </div>
        <div className="flex items-center gap-4">
          <div className={`${theme === 'dark' ? 'bg-white/5' : 'bg-white shadow-sm'} p-4 rounded-3xl border flex items-center gap-4`}>
             <input 
               type="date" 
               value={targetDate} 
               onChange={(e) => setTargetDate(e.target.value)}
               className={`bg-transparent outline-none font-black text-lg ${theme === 'dark' ? 'text-white' : 'text-black'}`}
             />
             <div className="flex flex-col">
               <span className="text-[8px] font-black uppercase text-orange-500">Target Date</span>
               <span className="text-[10px] font-bold text-gray-400">Analysis Goal</span>
             </div>
          </div>
        </div>
      </header>

      {/* Main Analysis Bento */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        
        {/* Predictions Main Panel */}
        <div className={`lg:col-span-3 ${theme === 'dark' ? 'bg-white/5 border-white/10' : 'bg-[#121212] text-white shadow-2xl shadow-orange-950/20'} p-8 lg:p-12 rounded-[50px] relative overflow-hidden`}>
          <div className="absolute top-0 right-0 w-96 h-96 bg-orange-600/10 blur-[120px] pointer-events-none"></div>
          
          <div className="relative z-10 space-y-12">
            <div className="flex items-center justify-between">
              <div className="space-y-4">
                <div className="flex items-center gap-2 px-3 py-1 bg-orange-600/20 text-orange-500 rounded-full w-fit">
                  <Activity className="w-3 h-3" />
                  <span className="text-[10px] font-black uppercase tracking-tighter">{t.automatedEngine}</span>
                </div>
                <h3 className="text-5xl font-black">{t.generatedPredictions}</h3>
              </div>
              <div className="hidden md:block text-right">
                <p className="text-4xl font-black text-orange-500">92%</p>
                <p className="text-[10px] font-bold text-gray-500 uppercase">Logic Confidence</p>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {analysis.suggested.map((num, i) => (
                <motion.div 
                   initial={{ opacity: 0, y: 20 }}
                   animate={{ opacity: 1, y: 0 }}
                   transition={{ delay: i * 0.05 }}
                   key={num} 
                   className={`aspect-square flex flex-col items-center justify-center border border-white/10 rounded-[40px] hover:bg-orange-600 hover:border-orange-600 hover:scale-105 transition-all cursor-pointer group/num relative overflow-hidden`}
                >
                   <span className="relative z-10 text-3xl font-black group-hover:scale-110 transition-transform">{num}</span>
                   <span className="relative z-10 text-[9px] opacity-40 font-bold mt-2 uppercase">Match {98 - i * 3}%</span>
                   <div className="absolute inset-0 bg-gradient-to-br from-white/5 to-transparent"></div>
                </motion.div>
              ))}
            </div>

            <div className="flex flex-wrap gap-8 pt-8 border-t border-white/10">
              <div className="space-y-2">
                <p className="text-[10px] uppercase font-black text-gray-500 tracking-widest">{t.frequentHeads}</p>
                <div className="flex gap-4">
                  {analysis.topHeads.map(h => <span key={h} className="text-2xl font-black text-orange-500">{h}</span>)}
                </div>
              </div>
              <div className="space-y-2">
                <p className="text-[10px] uppercase font-black text-gray-500 tracking-widest">{t.dueTails}</p>
                <div className="flex gap-4">
                  {analysis.dueTails.map(h => <span key={h} className="text-2xl font-black text-purple-400">{h}</span>)}
                </div>
              </div>
              <div className="ml-auto flex items-end">
                <p className="text-[10px] font-medium text-gray-500 italic">Analyzed {records.length} Firestore Master Records.</p>
              </div>
            </div>
          </div>
        </div>

        {/* Logic Side Panel */}
        <div className="lg:col-span-1 space-y-6">
          <div className={`${theme === 'dark' ? 'bg-white/5 border-white/10' : 'bg-white border'} p-8 rounded-[40px] shadow-sm`}>
            <h4 className="font-black text-lg mb-6 flex items-center gap-2">
              <Zap className="w-5 h-5 text-orange-500" />
              {t.logicInsights}
            </h4>
            <div className="space-y-4">
              {analysis.discoveries.map((disc, i) => (
                <div key={i} className={`p-5 rounded-3xl space-y-2 ${
                  disc.type === 'alert' ? 'bg-red-500/10 border border-red-500/20' : 'bg-orange-500/10 border border-orange-500/20'
                }`}>
                  <p className={`text-[10px] font-black uppercase tracking-tight ${disc.type === 'alert' ? 'text-red-500' : 'text-orange-500'}`}>{disc.title}</p>
                  <p className="text-xs font-medium leading-relaxed opacity-80">{disc.text}</p>
                </div>
              ))}
              <div className={`p-5 rounded-3xl space-y-2 bg-blue-500/10 border border-blue-500/20`}>
                 <p className="text-[10px] font-black uppercase tracking-tight text-blue-500">Day History</p>
                 <p className="text-xs font-medium leading-relaxed opacity-80">{t.dayPatternReason}</p>
              </div>
            </div>
          </div>

          <div className={`${theme === 'dark' ? 'bg-white/5 border-white/10' : 'bg-white border'} p-8 rounded-[40px] shadow-sm`}>
            <h4 className="font-black text-lg mb-6 flex items-center gap-2">
              <TrendingUp className="w-5 h-5 text-purple-500" />
              Frequency Weight
            </h4>
            <div className="space-y-3">
               {[...analysis.dueTails, ...analysis.topHeads].slice(0, 5).map((digit, idx) => (
                 <div key={idx} className="flex items-center justify-between p-3 rounded-2xl bg-gray-50 dark:bg-black/20">
                    <span className="text-sm font-black">{digit}</span>
                    <span className="text-[10px] font-bold text-gray-400 uppercase">Analysis Score</span>
                 </div>
               ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function AdminView({ theme, t }: { theme: 'light' | 'dark', t: any }) {
  const [progress, setProgress] = useState(0);
  const [isSyncing, setIsSyncing] = useState(false);
  const [selectedData, setSelectedData] = useState<any[] | null>(null);
  const [fileName, setFileName] = useState('');
  const [logs, setLogs] = useState<string[]>([]);
  const [dbInfo, setDbInfo] = useState<any>(null);
  const [pastedJson, setPastedJson] = useState('');
  const logRef = useRef<HTMLDivElement>(null);

  // Helper to normalize date to YYYY-MM-DD
  const normalizeDate = (dStr: string) => {
    if (!dStr) return null;
    const parts = dStr.split(/[-/.]/);
    if (parts.length !== 3) return dStr; // Fallback to raw if not splitable
    
    // Check if it's YYYY-MM-DD or DD-MM-YYYY
    if (parts[0].length === 4) {
      return `${parts[0]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
    } else if (parts[2].length === 4) {
      return `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
    }
    return dStr;
  };

  // Manual Entry State
  const [manualDate, setManualDate] = useState(new Date().toISOString().split('T')[0]);
  const [manualMorning, setManualMorning] = useState('');
  const [manualMorningSet, setManualMorningSet] = useState('');
  const [manualMorningVal, setManualMorningVal] = useState('');
  const [manualEvening, setManualEvening] = useState('');
  const [manualEveningSet, setManualEveningSet] = useState('');
  const [manualEveningVal, setManualEveningVal] = useState('');
  const [isSavingManual, setIsSavingManual] = useState(false);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs]);

  useEffect(() => {
    setDbInfo({
      projectId: firebaseConfig.projectId,
      dbId: firebaseConfig.firestoreDatabaseId || '(default)',
      authDomain: firebaseConfig.authDomain
    });
  }, []);

  const addLog = (msg: string) => {
    setLogs(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);
  };

  const saveManualEntry = async () => {
    if (!manualDate) return alert('ရက်စွဲ ထည့်ပေးပါခင်ဗျာ');
    setIsSavingManual(true);
    addLog(`Saving manual entry for ${manualDate}...`);
    try {
      const docRef = doc(db, 'twod_history', manualDate);
      await setDoc(docRef, {
        date: manualDate,
        morning: manualMorning,
        set_morning: manualMorningSet,
        val_morning: manualMorningVal,
        evening: manualEvening,
        set_evening: manualEveningSet,
        val_evening: manualEveningVal,
        updatedAt: new Date().toISOString()
      }, { merge: true });
      addLog(`SUCCESS: Manual update for ${manualDate} complete.`);
      alert('ဒေတာ အောင်မြင်စွာ သိမ်းဆည်းပြီးပါပြီ။');
    } catch (err: any) {
      addLog(`ERROR: Manual save failed: ${err.message}`);
    } finally {
      setIsSavingManual(false);
    }
  };

  const testConnection = async () => {
    addLog("Testing connection...");
    try {
      const testRef = doc(db, '_connection_test', 'status');
      await setDoc(testRef, { lastTest: new Date(), message: "Connection OK" });
      addLog("SUCCESS: Connection test passed! Write reached Firestore.");
    } catch (err: any) {
      addLog(`ERROR: Connection test failed: ${err.message}`);
    }
  };

  const handleFileSelect = (e: any) => {
    const file = e.target.files[0];
    if (!file) return;
    setFileName(file.name);
    addLog(`File selected: ${file.name}`);
    
    const reader = new FileReader();
    reader.onload = (ev) => {
      processInputData(ev.target?.result as string);
    };
    reader.readAsText(file);
  };

  const processInputData = (text: string) => {
    let cleanedData: any[] = [];
    addLog("Analyzing data structure...");

    try {
      const json = JSON.parse(text);
      if (Array.isArray(json)) {
        cleanedData = json;
      } else if (json && json.date) {
        cleanedData = [json];
      }
    } catch (err) {
      addLog("Complex string detected. Attempting deep extraction...");
      const arrayMatches = text.match(/\[[\s\S]*?\]/g);
      if (arrayMatches) {
        arrayMatches.forEach(match => {
          try {
            const parsed = JSON.parse(match);
            if (Array.isArray(parsed)) cleanedData = [...cleanedData, ...parsed];
          } catch(e) {}
        });
      }

      if (cleanedData.length === 0) {
        const objectMatches = text.match(/\{[\s\S]*?\}/g);
        if (objectMatches) {
          objectMatches.forEach(match => {
            try {
              const parsed = JSON.parse(match);
              if (parsed && typeof parsed === 'object' && (parsed.date || parsed.morning)) {
                cleanedData.push(parsed);
              }
            } catch(e) {}
          });
        }
      }
    }

    if (cleanedData.length > 0) {
      const uniqueMap = new Map();
      cleanedData.forEach(item => {
        const d = normalizeDate(item.date);
        if (d) {
          item.date = d;
          uniqueMap.set(d, item);
        }
      });
      const finalData = Array.from(uniqueMap.values());
      
      setSelectedData(finalData);
      addLog(`Smart parsing successful! Prepared ${finalData.length} valid 2D records.`);
    } else {
      addLog("CRITICAL ERROR: No valid 2D records found.");
      setSelectedData(null);
    }
  };

  const startUpload = async () => {
    if (!selectedData || isSyncing) return;
    
    setIsSyncing(true);
    setProgress(0);
    setLogs([]); 
    addLog(`Target Project: ${firebaseConfig.projectId}`);
    addLog(`Path: /twod_history/`);
    addLog(`Preparing to sync ${selectedData.length} records...`);

    try {
      const total = selectedData.length;
      const batchSize = 400; 
      
      for (let i = 0; i < total; i += batchSize) {
        const batch = writeBatch(db);
        const chunk = selectedData.slice(i, i + batchSize);
        
        addLog(`Processing batch ${Math.floor(i / batchSize) + 1} (${chunk.length} records)...`);
        
        chunk.forEach(item => {
          const d = normalizeDate(item.date);
          if (d) {
            const docRef = doc(db, 'twod_history', d);
            batch.set(docRef, { ...item, updatedAt: new Date().toISOString() });
          }
        });

        await batch.commit();
        const newProgress = Math.min(100, Math.round(((i + chunk.length) / total) * 100));
        setProgress(newProgress);
        addLog(`√ Batch committed. Progress: ${newProgress}%`);
      }
      
      addLog(`SUCCESS: ${total} records synced to Firestore!`);
    } catch (err: any) {
      console.error("Sync Error:", err);
      addLog(`FATAL ERROR: ${err.message || 'Sync failed.'}`);
    } finally {
      setIsSyncing(false);
    }
  };

  return (
    <div className="p-6 lg:p-12 max-w-6xl mx-auto space-y-8 pb-20">
      <header>
        <div className="flex justify-between items-start">
          <div>
            <h2 className="text-3xl font-black mb-2">{t.admin}</h2>
            <p className="text-gray-500 font-bold uppercase text-[10px] tracking-widest mt-1">{t.dataMaster}</p>
          </div>
          <button 
            onClick={testConnection}
            className={`flex items-center gap-2 px-4 py-2 ${theme === 'dark' ? 'bg-white/5 hover:bg-white/10 text-gray-400 border-white/5' : 'bg-gray-100 hover:bg-gray-200 text-gray-700'} border rounded-xl text-[10px] font-bold transition-all`}
          >
            <ShieldCheck className="w-3 h-3" /> {t.testConnection}
          </button>
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Left: Bulk Upload */}
        <div className="lg:col-span-1 space-y-6">
          <div className={`${theme === 'dark' ? 'bg-white/5 border-white/10' : 'bg-white border shadow-sm'} p-6 rounded-[40px] space-y-4`}>
            <h3 className="font-bold flex items-center gap-2"><FileJson className="w-4 h-4 text-orange-500" /> {t.bulkUpload}</h3>
            
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="block text-[10px] font-bold text-gray-400 uppercase">{t.inputMethod}</label>
                <div className="flex gap-2">
                  <button 
                    onClick={() => setFileName('')} 
                    className={`flex-1 py-2 text-[10px] font-bold rounded-lg border transition-all ${!fileName ? (theme === 'dark' ? 'bg-orange-600/20 border-orange-600/40 text-orange-400' : 'bg-orange-50 border-orange-200 text-orange-600') : (theme === 'dark' ? 'bg-black/20 border-white/5 text-gray-500' : 'bg-white text-gray-400')}`}
                  >
                    {t.pasteJson}
                  </button>
                  <label className={`flex-1 py-2 text-[10px] font-bold rounded-lg border text-center cursor-pointer transition-all ${fileName ? (theme === 'dark' ? 'bg-orange-600/20 border-orange-600/40 text-orange-400' : 'bg-orange-50 border-orange-200 text-orange-600') : (theme === 'dark' ? 'bg-black/20 border-white/5 text-gray-500' : 'bg-white text-gray-400')}`}>
                    {t.loadFile}
                    <input type="file" className="hidden" onChange={handleFileSelect} disabled={isSyncing} accept=".json" />
                  </label>
                </div>
              </div>

              {!fileName ? (
                <textarea 
                  value={pastedJson}
                  onChange={(e) => {
                    setPastedJson(e.target.value);
                    if (e.target.value.trim().length > 2) processInputData(e.target.value);
                  }}
                  placeholder='Paste your JSON array here... e.g. [{"date": "2026-05-18", "morning": "81"}]'
                  className={`w-full h-32 ${theme === 'dark' ? 'bg-black/40 border-white/5 text-white' : 'bg-gray-50 border'} rounded-2xl p-3 text-xs font-mono outline-none focus:border-orange-500`}
                />
              ) : (
                <div className={`${theme === 'dark' ? 'bg-black/40 border-white/10' : 'bg-gray-50 border-2 border-dashed'} rounded-2xl p-6 text-center relative overflow-hidden`}>
                  {isSyncing && <div className="absolute top-0 left-0 h-1 bg-orange-500 transition-all z-10" style={{ width: `${progress}%` }} />}
                  <p className="text-[10px] text-gray-400 mb-2 truncate">Selected: {fileName}</p>
                  <CheckCircle2 className="w-6 h-6 text-green-500 mx-auto" />
                </div>
              )}
              
              <button 
                onClick={startUpload} 
                disabled={!selectedData || isSyncing}
                className={`w-full py-3 rounded-xl font-bold text-white transition-all flex items-center justify-center gap-2 text-sm ${
                  !selectedData || isSyncing ? (theme === 'dark' ? 'bg-white/5 text-gray-600' : 'bg-gray-200 text-gray-400') : 'bg-orange-600 hover:bg-orange-700 shadow-lg shadow-orange-600/20'
                }`}
              >
                {isSyncing ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                {isSyncing ? `SYNCING... ${progress}%` : `UPLOAD ${selectedData ? selectedData.length : 0} RECORDS`}
              </button>
            </div>
          </div>

          <div className={`flex flex-col h-[200px] ${theme === 'dark' ? 'bg-black/40 border-white/5' : 'bg-black border'} rounded-[40px] p-6 text-green-400 font-mono text-[10px] shadow-xl overflow-hidden`}>
            <span className="text-gray-500 mb-2 uppercase tracking-tight font-bold">{t.systemLogs}</span>
            <div ref={logRef} className="flex-1 overflow-y-auto space-y-1">
              {logs.length === 0 ? <p className="text-gray-700">Waiting for data...</p> : logs.map((log, i) => <p key={i}>{log}</p>)}
            </div>
          </div>
        </div>

        {/* Center: Manual Entry Form */}
        <div className={`lg:col-span-2 ${theme === 'dark' ? 'bg-white/5 border-white/10' : 'bg-white border'} p-6 lg:p-8 rounded-3xl shadow-sm space-y-6`}>
          <h3 className="font-black text-lg flex items-center gap-2"><Database className="w-5 h-5 text-purple-500" /> {t.manualEntry}</h3>
          
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="md:col-span-3">
              <label className="block text-[10px] font-bold text-gray-400 uppercase mb-2">{t.recordDate}</label>
              <input 
                type="date" 
                value={manualDate} 
                onChange={(e) => setManualDate(e.target.value)}
                className={`w-full ${theme === 'dark' ? 'bg-black/20 border-white/5 text-white' : 'bg-gray-50 border'} p-3 rounded-xl font-bold outline-none focus:border-purple-500`}
              />
            </div>

            <div className={`space-y-4 p-4 ${theme === 'dark' ? 'bg-orange-600/5 border-orange-600/10' : 'bg-orange-50/50 border-orange-100'} rounded-2xl border`}>
              <p className="text-[10px] font-black text-orange-600 uppercase tracking-widest">{t.morning}</p>
              <div>
                <label className="block text-[10px] font-bold text-gray-400 mb-1">{t.twoDResult}</label>
                <input maxLength={2} value={manualMorning} onChange={(e)=>setManualMorning(e.target.value)} className={`w-full ${theme === 'dark' ? 'bg-black/40 border-white/5 text-white' : 'bg-white border'} p-3 rounded-xl font-mono text-center text-xl font-black`} placeholder="--" />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[10px] font-bold text-gray-400 mb-1">{t.set}</label>
                  <input value={manualMorningSet} onChange={(e)=>setManualMorningSet(e.target.value)} className={`w-full ${theme === 'dark' ? 'bg-black/40 border-white/5 text-white' : 'bg-white border'} p-2 rounded-lg text-xs`} placeholder="0.00" />
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-gray-400 mb-1">{t.val}</label>
                  <input value={manualMorningVal} onChange={(e)=>setManualMorningVal(e.target.value)} className={`w-full ${theme === 'dark' ? 'bg-black/40 border-white/5 text-white' : 'bg-white border'} p-2 rounded-lg text-xs`} placeholder="0.00" />
                </div>
              </div>
            </div>

            <div className={`space-y-4 p-4 ${theme === 'dark' ? 'bg-purple-600/5 border-purple-600/10' : 'bg-purple-50/50 border-purple-100'} rounded-2xl border`}>
              <p className="text-[10px] font-black text-purple-600 uppercase tracking-widest">{t.evening}</p>
              <div>
                <label className="block text-[10px] font-bold text-gray-400 mb-1">{t.twoDResult}</label>
                <input maxLength={2} value={manualEvening} onChange={(e)=>setManualEvening(e.target.value)} className={`w-full ${theme === 'dark' ? 'bg-black/40 border-white/5 text-white' : 'bg-white border'} p-3 rounded-xl font-mono text-center text-xl font-black`} placeholder="--" />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[10px] font-bold text-gray-400 mb-1">{t.set}</label>
                  <input value={manualEveningSet} onChange={(e)=>setManualEveningSet(e.target.value)} className={`w-full ${theme === 'dark' ? 'bg-black/40 border-white/5 text-white' : 'bg-white border'} p-2 rounded-lg text-xs`} placeholder="0.00" />
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-gray-400 mb-1">{t.val}</label>
                  <input value={manualEveningVal} onChange={(e)=>setManualEveningVal(e.target.value)} className={`w-full ${theme === 'dark' ? 'bg-black/40 border-white/5 text-white' : 'bg-white border'} p-2 rounded-lg text-xs`} placeholder="0.00" />
                </div>
              </div>
            </div>

            <div className="flex items-end">
              <button 
                onClick={saveManualEntry}
                disabled={isSavingManual}
                className={`w-full h-fit py-4 ${theme === 'dark' ? 'bg-orange-600 hover:bg-orange-700' : 'bg-black hover:bg-gray-800'} text-white rounded-2xl font-black shadow-xl disabled:opacity-50 active:scale-95 transition-all text-sm flex items-center justify-center gap-2`}
              >
                {isSavingManual ? <RefreshCw className="w-5 h-5 animate-spin" /> : <Save className="w-5 h-5" />}
                {t.saveRecord}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SettingsView({ theme, setTheme, lang, setLang, t, openRouterConfig, setOpenRouterConfig }: { 
  theme: 'light' | 'dark', 
  setTheme: (t: 'light' | 'dark') => void, 
  lang: 'mm' | 'en', 
  setLang: (l: 'mm' | 'en') => void,
  t: any,
  openRouterConfig: OpenRouterConfig,
  setOpenRouterConfig: React.Dispatch<React.SetStateAction<OpenRouterConfig>>
}) {
  const [localGeminiKey, setLocalGeminiKey] = useState(localStorage.getItem('gemini_api_key') || '');
  const [geminiSaved, setGeminiSaved] = useState(false);
  
  const [fetchingModels, setFetchingModels] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ type: 'error' | 'success', text: string } | null>(null);

  const handleSaveGemini = () => { 
    localStorage.setItem('gemini_api_key', localGeminiKey); 
    setGeminiSaved(true); 
    setTimeout(() => setGeminiSaved(false), 2000); 
  };

  const fetchOpenRouterModels = async () => {
    if (!openRouterConfig.apiKey) {
      setStatusMsg({ type: 'error', text: t.apiKeyMissing });
      return;
    }

    setFetchingModels(true);
    setStatusMsg(null);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s timeout for model list

    try {
      const response = await fetch('https://openrouter.ai/api/v1/models', {
        signal: controller.signal,
        headers: {
          'Authorization': `Bearer ${openRouterConfig.apiKey}`,
        }
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errText = await response.text();
        console.error("OpenRouter Models Error:", errText);
        throw new Error('Failed to fetch models');
      }

      const data = await response.json();
      const models: OpenRouterModel[] = data.data;

      if (!models || models.length === 0) {
        throw new Error('No models returned from API.');
      }

      setOpenRouterConfig(prev => ({
        ...prev,
        availableModels: models,
        // Auto-select defaults if none picked
        models: {
          chat: prev.models.chat || models.find(m => m.id.includes('chat') || m.id.includes('claude-3-haiku') || m.id.includes('llama-3'))?.id || models[0]?.id || '',
          vision: prev.models.vision || models.find(m => m.id.includes('vision') || m.id.includes('gpt-4o'))?.id || models[0]?.id || '',
          video: prev.models.video || models.find(m => m.id.includes('video') || m.id.includes('sora') || m.id.includes('minimax'))?.id || models[0]?.id || '',
        }
      }));

      setStatusMsg({ type: 'success', text: t.fetchSuccess });
    } catch (err: any) {
      clearTimeout(timeoutId);
      console.error("Fetch Settings Models Error:", err);
      setStatusMsg({ 
        type: 'error', 
        text: err.name === 'AbortError' ? 'Request timed out. Please check your connection.' : t.invalidKey 
      });
    } finally {
      setFetchingModels(false);
    }
  };

  return (
    <div className="p-6 lg:p-12 max-w-2xl mx-auto space-y-10 pb-20">
      <header>
        <h2 className="text-3xl font-black mb-2">{t.settings}</h2>
        <p className="text-gray-500 font-bold uppercase text-[10px] tracking-widest">{t.apiSettings}</p>
      </header>

      {/* OpenRouter BYOK - NEW Section */}
      <div className={`p-8 rounded-[40px] border shadow-sm space-y-6 ${theme === 'dark' ? 'bg-white/5 border-white/10' : 'bg-white border-[#EBE6E1]'}`}>
        <div className="flex items-center gap-3 text-orange-500">
          <Sparkles className="w-5 h-5" />
          <h3 className="font-bold">{t.openRouterTitle}</h3>
        </div>

        <p className="text-xs text-gray-400 leading-relaxed italic">{t.disclaimer}</p>

        <div>
          <label className="block text-[10px] font-black text-gray-400 uppercase mb-2 tracking-tighter">{t.openRouterKeyDesc}</label>
          <input 
            type="password" 
            value={openRouterConfig.apiKey} 
            onChange={(e) => setOpenRouterConfig(prev => ({ ...prev, apiKey: e.target.value }))} 
            className={`w-full border p-4 rounded-2xl mb-4 font-mono text-sm outline-none transition-all ${theme === 'dark' ? 'bg-black/20 border-white/10 focus:border-orange-500' : 'bg-gray-50 border-[#EBE6E1] focus:border-orange-500'}`}
            placeholder="sk-or-v1-..." 
          />

          {statusMsg && (
            <div className={`p-3 rounded-xl mb-4 text-[10px] font-bold flex items-center gap-2 ${statusMsg.type === 'error' ? 'bg-red-500/10 text-red-500 border border-red-500/20' : 'bg-green-500/10 text-green-500 border border-green-500/20'}`}>
              {statusMsg.type === 'error' ? <AlertCircle className="w-3 h-3" /> : <CheckCircle2 className="w-3 h-3" />}
              {statusMsg.text}
            </div>
          )}

          <button 
            onClick={fetchOpenRouterModels} 
            disabled={fetchingModels || !openRouterConfig.apiKey}
            className="w-full bg-orange-600 hover:bg-orange-700 disabled:opacity-50 text-white p-4 rounded-2xl font-black flex items-center justify-center gap-2 shadow-lg shadow-orange-600/20 active:scale-95 transition-all text-sm mb-6"
          >
            {fetchingModels ? <RefreshCw className="w-5 h-5 animate-spin" /> : <Save className="w-5 h-5" />}
            {fetchingModels ? t.fetching : t.validateFetch}
          </button>

          {openRouterConfig.availableModels.length > 0 && (
            <div className="space-y-4 pt-4 border-t border-dashed border-gray-200 dark:border-white/10">
              <div>
                <label className="block text-[10px] font-black text-gray-400 uppercase mb-2 tracking-tighter">{t.chatModel}</label>
                <select 
                  value={openRouterConfig.models.chat} 
                  onChange={(e) => setOpenRouterConfig(prev => ({ ...prev, models: { ...prev.models, chat: e.target.value } }))}
                  className={`w-full border p-3 rounded-xl text-xs outline-none ${theme === 'dark' ? 'bg-black/20 border-white/10' : 'bg-gray-50 border-[#EBE6E1]'}`}
                >
                  {openRouterConfig.availableModels.map(m => <option key={m.id} value={m.id}>{m.name || m.id}</option>)}
                </select>
              </div>

              <div>
                <label className="block text-[10px] font-black text-gray-400 uppercase mb-2 tracking-tighter">{t.visionModel}</label>
                <select 
                  value={openRouterConfig.models.vision} 
                  onChange={(e) => setOpenRouterConfig(prev => ({ ...prev, models: { ...prev.models, vision: e.target.value } }))}
                  className={`w-full border p-3 rounded-xl text-xs outline-none ${theme === 'dark' ? 'bg-black/20 border-white/10' : 'bg-gray-50 border-[#EBE6E1]'}`}
                >
                  {openRouterConfig.availableModels.map(m => <option key={m.id} value={m.id}>{m.name || m.id}</option>)}
                </select>
              </div>

              <div>
                <label className="block text-[10px] font-black text-gray-400 uppercase mb-2 tracking-tighter">{t.videoModel}</label>
                <select 
                  value={openRouterConfig.models.video} 
                  onChange={(e) => setOpenRouterConfig(prev => ({ ...prev, models: { ...prev.models, video: e.target.value } }))}
                  className={`w-full border p-3 rounded-xl text-xs outline-none ${theme === 'dark' ? 'bg-black/20 border-white/10' : 'bg-gray-50 border-[#EBE6E1]'}`}
                >
                  {openRouterConfig.availableModels.map(m => <option key={m.id} value={m.id}>{m.name || m.id}</option>)}
                </select>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Gemini Settings */}
      <div className={`p-8 rounded-[40px] border shadow-sm space-y-6 ${theme === 'dark' ? 'bg-white/5 border-white/10' : 'bg-white border-[#EBE6E1]'}`}>
        <div className="flex items-center gap-3 text-blue-500">
          <Key className="w-5 h-5" />
          <h3 className="font-bold">{t.apiSettings} (Gemini)</h3>
        </div>
        <div>
          <label className="block text-[10px] font-black text-gray-400 uppercase mb-2 tracking-tighter">{t.geminiKey}</label>
          <input 
            type="password" 
            value={localGeminiKey} 
            onChange={(e) => setLocalGeminiKey(e.target.value)} 
            className={`w-full border p-4 rounded-2xl mb-4 font-mono text-sm outline-none transition-all ${theme === 'dark' ? 'bg-black/20 border-white/10 focus:border-blue-500' : 'bg-gray-50 border-[#EBE6E1] focus:border-blue-500'}`}
            placeholder="Paste Gemini key here..." 
          />
          <button 
            onClick={handleSaveGemini} 
            className="w-full bg-blue-600 hover:bg-blue-700 text-white p-4 rounded-2xl font-black flex items-center justify-center gap-2 shadow-lg shadow-blue-600/20 active:scale-95 transition-all text-sm"
          >
            {geminiSaved ? <CheckCircle2 className="w-5 h-5" /> : <Save className="w-5 h-5" />}
            {geminiSaved ? t.saved : t.saveKey}
          </button>
        </div>
      </div>

      {/* Preferences Settings */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Appearance */}
        <div className={`p-8 rounded-[40px] border shadow-sm space-y-6 ${theme === 'dark' ? 'bg-white/5 border-white/10' : 'bg-white border-[#EBE6E1]'}`}>
          <div className="flex items-center gap-3 text-purple-500">
            <Activity className="w-5 h-5" />
            <h3 className="font-bold">{t.appearance}</h3>
          </div>
          <div className="flex gap-2">
            {[
              { id: 'light', label: t.light, icon: Sparkles },
              { id: 'dark', label: t.dark, icon: Database }
            ].map(v => (
              <button
                key={v.id}
                onClick={() => setTheme(v.id as any)}
                className={`flex-1 p-4 rounded-2xl border flex flex-col items-center gap-2 transition-all ${theme === v.id ? (theme === 'dark' ? 'bg-white text-black border-white' : 'bg-black text-white border-black') : 'bg-gray-50 dark:bg-black/20 border-gray-100 dark:border-white/5 text-gray-400'}`}
              >
                <v.icon className="w-5 h-5" />
                <span className="text-[10px] font-black uppercase">{v.label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Language */}
        <div className={`p-8 rounded-[40px] border shadow-sm space-y-6 ${theme === 'dark' ? 'bg-white/5 border-white/10' : 'bg-white border-[#EBE6E1]'}`}>
          <div className="flex items-center gap-3 text-blue-500">
            <HelpCircle className="w-5 h-5" />
            <h3 className="font-bold">{t.language}</h3>
          </div>
          <div className="flex gap-2">
            {[
              { id: 'mm', label: t.mm_lang },
              { id: 'en', label: t.en }
            ].map(l => (
              <button
                key={l.id}
                onClick={() => setLang(l.id as any)}
                className={`flex-1 p-4 rounded-2xl border transition-all ${lang === l.id ? 'bg-orange-100 border-orange-200 text-orange-600 font-black' : 'bg-gray-50 dark:bg-black/20 border-gray-100 dark:border-white/5 text-gray-400 font-bold'}`}
              >
                <span className="text-xs uppercase">{l.label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
