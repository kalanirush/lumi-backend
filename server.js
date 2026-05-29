require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(cors({
  origin: '*', // Chrome extensions need this
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'X-User-ID']
}));

// Rate limiting — 30 requests per hour per IP
const limiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a bit and try again.' }
});
app.use('/analyze', limiter);

// ── In-memory usage tracking (swap for a DB later) ────────────────────────────
// Maps userId -> { count, resetAt }
const usage = new Map();

function getUsage(userId) {
  const now = Date.now();
  const record = usage.get(userId);
  if (!record || now > record.resetAt) {
    // Reset monthly
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

// ── Routes ────────────────────────────────────────────────────────────────────

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Lumi API', version: '1.0.0' });
});

// Register a new user — returns a userId they store locally
app.post('/register', (req, res) => {
  const userId = uuidv4();
  getUsage(userId); // Initialize record
  res.json({ userId, message: 'Welcome to Lumi!' });
});

// Get usage stats for a user
app.get('/usage/:userId', (req, res) => {
  const { userId } = req.params;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });
  const record = getUsage(userId);
  res.json({
    userId,
    analysesThisMonth: record.count,
    resetsAt: new Date(record.resetAt).toISOString(),
    plan: 'free' // extend with Stripe later
  });
});

// Main analyze endpoint
app.post('/analyze', async (req, res) => {
  const { ticker, userId } = req.body;

  // Validate ticker
  if (!ticker || !/^[A-Z.\-]{1,10}$/i.test(ticker)) {
    return res.status(400).json({ error: 'Invalid ticker symbol' });
  }

  // Validate userId
  if (!userId) {
    return res.status(400).json({ error: 'Missing userId. Please reinstall Lumi.' });
  }

  // Check API key is configured
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Server configuration error. Contact support.' });
  }

  // Track usage
  const record = incrementUsage(userId);
  console.log(`[Lumi] Analyzing ${ticker.toUpperCase()} for user ${userId.slice(0, 8)}... (${record.count} this month)`);

  const prompt = `Analyze stock ticker: ${ticker.toUpperCase()}. Search for current price, P/E ratio, market cap, 52-week range, revenue growth, EPS, analyst consensus (% buy/hold/sell), avg price target, and 3 recent news headlines from the last 2 weeks. Respond ONLY with this exact JSON structure, no markdown, no extra text:
{
  "sentiment": "Bullish" or "Bearish" or "Neutral",
  "confidence": "High" or "Medium" or "Low",
  "outlook": "2-3 sentence plain English summary written for a beginner investor",
  "metrics": [
    {"label": "Price", "value": "$XXX.XX"},
    {"label": "P/E Ratio", "value": "XX.X"},
    {"label": "Market Cap", "value": "$XXXb"},
    {"label": "52W Range", "value": "$XX–$XXX"},
    {"label": "Rev Growth", "value": "+XX%"},
    {"label": "EPS", "value": "$X.XX"}
  ],
  "analysts": {
    "buy": <integer 0-100>,
    "hold": <integer 0-100>,
    "sell": <integer 0-100>,
    "priceTarget": "$XXX"
  },
  "news": [
    {"headline": "...", "source": "...", "tone": "positive" or "negative" or "neutral"},
    {"headline": "...", "source": "...", "tone": "positive" or "negative" or "neutral"},
    {"headline": "...", "source": "...", "tone": "positive" or "negative" or "neutral"}
  ],
  "risks": ["Risk 1 in one sentence", "Risk 2 in one sentence", "Risk 3 in one sentence"]
}`;

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

    // Robust JSON extraction
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

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🌟 Lumi backend running on port ${PORT}`);
});
