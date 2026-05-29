require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust Railway's proxy
app.set('trust proxy', 1);

app.use(express.json());
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'X-User-ID']
}));

const limiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a bit and try again.' }
});
app.use('/analyze', limiter);

const usage = new Map();

function getUsage(userId) {
  const now = Date.now();
  const record = usage.get(userId);
  if (!record || now > record.resetAt) {
    const resetAt = new Date();
    resetAt.setMonth(resetAt.getMonth() + 1);
    resetAt.setDate(1);
    resetAt.setHours(0, 0, 0, 0);
    const fresh = { count: 0, resetAt: resetAt.getTime() };
    usage.set(userId, fresh);
    return fresh;
  }
  return record;
}

function incrementUsage(userId) {
  const record = getUsage(userId);
  record.count += 1;
  usage.set(userId, record);
  return record;
}

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Lumi API', version: '1.0.0' });
});

app.post('/register', (req, res) => {
  const userId = uuidv4();
  getUsage(userId);
  res.json({ userId, message: 'Welcome to Lumi!' });
});

app.get('/usage/:userId', (req, res) => {
  const { userId } = req.params;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });
  const record = getUsage(userId);
  res.json({
    userId,
    analysesThisMonth: record.count,
    resetsAt: new Date(record.resetAt).toISOString(),
    plan: 'free'
  });
});

app.post('/analyze', async (req, res) => {
  const { ticker, userId } = req.body;

  if (!ticker || ticker.length < 1 || ticker.length > 50) {
    return res.status(400).json({ error: 'Invalid ticker or company name' });
  }

  if (!userId) {
    return res.status(400).json({ error: 'Missing userId. Please reinstall Lumi.' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Server configuration error. Contact support.' });
  }

  const record = incrementUsage(userId);
  console.log(`[Lumi] Analyzing "${ticker}" for user ${userId.slice(0, 8)}... (${record.count} this month)`);

  const prompt = `The user wants to analyze this stock: "${ticker}". First identify the correct stock ticker symbol if a company name was provided (e.g. "Apple" = AAPL, "Tesla" = TSLA). Then search for current price, P/E ratio, market cap, 52-week range, revenue growth, EPS, analyst consensus (% buy/hold/sell), avg price target, and 3 recent news headlines from the last 2 weeks. Respond ONLY with this exact JSON, no markdown, no extra text:
{"sentiment":"Bullish or Bearish or Neutral","confidence":"High or Medium or Low","outlook":"2-3 sentence plain English summary for a beginner investor","metrics":[{"label":"Price","value":"$XXX"},{"label":"P/E Ratio","value":"XX.X"},{"label":"Market Cap","value":"$XXXb"},{"label":"52W Range","value":"$XX-$XXX"},{"label":"Rev Growth","value":"+XX%"},{"label":"EPS","value":"$X.XX"}],"analysts":{"buy":0,"hold":0,"sell":0,"priceTarget":"$XXX"},"news":[{"headline":"...","source":"...","tone":"positive or negative or neutral","url":"https://... or null"},{"headline":"...","source":"...","tone":"positive or negative or neutral","url":"https://... or null"},{"headline":"...","source":"...","tone":"positive or negative or neutral","url":"https://... or null"}],"risks":["...","...","..."]}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1500,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const err = await response.json();
      console.error('[Lumi] Anthropic error:', err);
      return res.status(502).json({ error: 'Analysis service temporarily unavailable. Try again in a moment.' });
    }

    const data = await response.json();
    const textBlock = data.content.find(b => b.type === 'text');
    if (!textBlock) {
      return res.status(502).json({ error: 'No response from analysis service.' });
    }

    const raw = textBlock.text;
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end === -1) {
      return res.status(502).json({ error: 'Could not parse analysis response.' });
    }

    const analysis = JSON.parse(raw.slice(start, end + 1));
    res.json({ success: true, ticker: ticker.toUpperCase(), analysis });

  } catch (err) {
    console.error('[Lumi] Server error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.listen(PORT, () => {
  console.log(`🌟 Lumi backend running on port ${PORT}`);
});
