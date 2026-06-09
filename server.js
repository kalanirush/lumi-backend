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
  res.json({ status: 'ok', service: 'Mila API', version: '1.0.0' });
});

app.post('/register', (req, res) => {
  const userId = uuidv4();
  getUsage(userId);
  res.json({ userId, message: 'Welcome to Mila!' });
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
    return res.status(400).json({ error: 'Missing userId. Please reinstall Mila.' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Server configuration error. Contact support.' });
  }

  const record = incrementUsage(userId);
  console.log(`[Mila] Analyzing "${ticker}" for user ${userId.slice(0, 8)}... (${record.count} this month)`);

  const prompt = `You are a stock analysis API. The user wants to analyze: "${ticker}".

STEP 1: If this is a company name, identify the correct stock ticker symbol (Apple=AAPL, Tesla=TSLA, Microsoft=MSFT etc).
STEP 2: Search the web RIGHT NOW for the most current data:
- Current real-time or most recent market price (search "[ticker] stock price today")
- P/E ratio, market cap, 52-week high and low
- Revenue growth YoY and EPS from most recent earnings
- Analyst buy/hold/sell ratings and average price target (must add up to 100%)
- 3 most recent news headlines from the last 7 days with their actual URLs
STEP 3: Return ONLY a valid JSON object. No introduction. No explanation. No markdown. No backticks. Just raw JSON.

Be honest and accurate. Use the actual real-time price from your search — do not estimate or use outdated data. If the stock is struggling, say Bearish. If mixed, say Neutral. Do not default to Bullish. Include both positive and negative news where they exist.

The JSON must follow this exact structure:
{"sentiment":"Bullish or Bearish or Neutral based on actual data","confidence":"High or Medium or Low","outlook":"2-3 honest plain English sentences covering both positives and concerns","metrics":[{"label":"Price","value":"$XXX.XX"},{"label":"P/E Ratio","value":"XX.X"},{"label":"Market Cap","value":"$XXXb"},{"label":"52W Range","value":"$XX-$XXX"},{"label":"Rev Growth","value":"+XX%"},{"label":"EPS","value":"$X.XX"}],"analysts":{"buy":0,"hold":0,"sell":0,"priceTarget":"$XXX"},"news":[{"headline":"actual headline text","source":"Source Name","tone":"positive or negative or neutral","url":"https://actual-url.com"},{"headline":"actual headline text","source":"Source Name","tone":"positive or negative or neutral","url":"https://actual-url.com"},{"headline":"actual headline text","source":"Source Name","tone":"positive or negative or neutral","url":"https://actual-url.com"}],"risks":["Specific risk 1","Specific risk 2","Specific risk 3"]}

CRITICAL: Use the real current price from your web search. analyst buy+hold+sell must equal exactly 100. News URLs must be real working links. Return ONLY the JSON.`;

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
      console.error('[Mila] Anthropic error:', err);
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
    console.error('[Mila] Server error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.listen(PORT, () => {
  console.log(`✦ Mila backend running on port ${PORT}`);
});
