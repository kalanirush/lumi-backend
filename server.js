require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

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

async function resolveTicker(query) {
  const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
  if (/^[A-Z]{1,5}$/.test(query.trim())) return query.trim().toUpperCase();
  try {
    const res = await fetch(`https://finnhub.io/api/v1/search?q=${encodeURIComponent(query)}&token=${FINNHUB_KEY}`);
    const data = await res.json();
    if (data.result && data.result.length > 0) {
      const us = data.result.find(r => r.type === 'Common Stock' && !r.symbol.includes('.'));
      return us ? us.symbol : data.result[0].symbol;
    }
  } catch (e) {
    console.error('[Mila] Ticker resolve error:', e);
  }
  return query.trim().toUpperCase();
}

async function getStockData(ticker) {
  const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
  try {
    const [quoteRes, profileRes, metricsRes] = await Promise.all([
      fetch(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${FINNHUB_KEY}`),
      fetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${ticker}&token=${FINNHUB_KEY}`),
      fetch(`https://finnhub.io/api/v1/stock/metric?symbol=${ticker}&metric=all&token=${FINNHUB_KEY}`)
    ]);
    const [quote, profile, metrics] = await Promise.all([
      quoteRes.json(), profileRes.json(), metricsRes.json()
    ]);
    const m = metrics.metric || {};
    const price = quote.c || null;
    const high52 = m['52WeekHigh'] || null;
    const low52 = m['52WeekLow'] || null;
    const marketCap = profile.marketCapitalization ? (profile.marketCapitalization / 1000).toFixed(2) : null;
    const pe = m.peNormalizedAnnual || m.peTTM || null;
    const eps = m.epsTTM || null;
    const revGrowth = m.revenueGrowthTTMYoy ? (m.revenueGrowthTTMYoy * 100).toFixed(1) : null;
    return {
      price: price ? `$${price.toFixed(2)}` : null,
      peRatio: pe ? pe.toFixed(1) : null,
      marketCap: marketCap ? `$${marketCap}b` : null,
      weekRange52: high52 && low52 ? `$${low52.toFixed(2)}-$${high52.toFixed(2)}` : null,
      revGrowth: revGrowth ? `${revGrowth > 0 ? '+' : ''}${revGrowth}%` : null,
      eps: eps ? `$${eps.toFixed(2)}` : null,
      companyName: profile.name || ticker
    };
  } catch (e) {
    console.error('[Mila] Finnhub error:', e);
    return null;
  }
}

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Mila API', version: '1.1.0' });
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
  const resolvedTicker = await resolveTicker(ticker);
  console.log(`[Mila] Analyzing ${resolvedTicker} for user ${userId.slice(0, 8)}... (${record.count} this month)`);

  const stockData = await getStockData(resolvedTicker);

  const metricsContext = stockData
    ? `Here are the REAL verified metrics for ${resolvedTicker} from a live data source — use these exact values:
- Company: ${stockData.companyName}
- Current Price: ${stockData.price || 'N/A'}
- P/E Ratio: ${stockData.peRatio || 'N/A'}
- Market Cap: ${stockData.marketCap || 'N/A'}
- 52-Week Range: ${stockData.weekRange52 || 'N/A'}
- Revenue Growth YoY: ${stockData.revGrowth || 'N/A'}
- EPS: ${stockData.eps || 'N/A'}`
    : `Use web search to find current data for ${resolvedTicker}.`;

  const prompt = `You are a stock analysis API for ${resolvedTicker}.

${metricsContext}

Search the web for:
- Analyst buy/hold/sell ratings and average price target
- 3 most recent news headlines from the last 7 days with real URLs
- Overall investment sentiment

Return ONLY valid raw JSON. No intro, no explanation, no markdown, no backticks.

Be honest — say Bearish if struggling, Neutral if mixed, do not default to Bullish.

{"sentiment":"Bullish or Bearish or Neutral","confidence":"High or Medium or Low","outlook":"2-3 honest plain English sentences covering both positives and concerns","metrics":[{"label":"Price","value":"${stockData?.price || 'N/A'}"},{"label":"P/E Ratio","value":"${stockData?.peRatio || 'N/A'}"},{"label":"Market Cap","value":"${stockData?.marketCap || 'N/A'}"},{"label":"52W Range","value":"${stockData?.weekRange52 || 'N/A'}"},{"label":"Rev Growth","value":"${stockData?.revGrowth || 'N/A'}"},{"label":"EPS","value":"${stockData?.eps || 'N/A'}"}],"analysts":{"buy":0,"hold":0,"sell":0,"priceTarget":"$XXX"},"news":[{"headline":"actual headline","source":"Source Name","tone":"positive or negative or neutral","url":"https://actual-url.com"},{"headline":"actual headline","source":"Source Name","tone":"positive or negative or neutral","url":"https://actual-url.com"},{"headline":"actual headline","source":"Source Name","tone":"positive or negative or neutral","url":"https://actual-url.com"}],"risks":["Risk 1","Risk 2","Risk 3"]}

analyst buy+hold+sell must equal exactly 100. Return ONLY the JSON.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
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
    res.json({ success: true, ticker: resolvedTicker, analysis });

  } catch (err) {
    console.error('[Mila] Server error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.listen(PORT, () => {
  console.log(`✦ Mila backend running on port ${PORT}`);
});
