import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';

import { analyzeLotteryPatterns } from './src/utils/lotteryAnalysis.js';

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '10mb' }));

// API Routes
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/api/lottery/analyze', async (req, res) => {
  const { targetDate } = req.body;
  if (!targetDate) {
    return res.status(400).json({ error: 'targetDate is required (YYYY-MM-DD)' });
  }

  const result = await analyzeLotteryPatterns(targetDate);
  if (result.success) {
    res.json(result);
  } else {
    res.status(500).json(result);
  }
});

app.post('/api/chat', async (req, res) => {
  const { history, message, systemInstruction } = req.body;
  
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY is not configured on the server.' });
  }

  const genAI = new GoogleGenAI({ 
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      }
    }
  });
  
  // Model fallback list
  const models = [
    'gemini-3.5-flash',
    'gemini-3.1-flash-lite',
    'gemini-3.1-pro-preview'
  ];

  let lastError = null;

  for (const modelName of models) {
    try {
      const result = await genAI.models.generateContent({
        model: modelName,
        contents: [
          ...(history || []),
          { role: 'user', parts: [{ text: message }] }
        ],
        config: {
          systemInstruction: systemInstruction,
          temperature: 0.7
        }
      });

      if (result.text) {
        return res.json({ text: result.text });
      }
    } catch (err: any) {
      console.error(`Error with model ${modelName}:`, err);
      lastError = err;
      // Try next model for any error to maximize chance of success
      continue;
    }
  }

  res.status(lastError?.status || 500).json({ 
    error: lastError?.message || 'AI Generation failed after trying multiple models.',
    details: lastError?.response?.data || lastError
  });
});

// Vite Integration
async function setupVite() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }
}

setupVite().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
});
