# Lumi Backend

The API server that powers the Lumi Chrome extension. Holds your Anthropic API key server-side so users never need their own.

---

## Deploy to Railway (5 minutes)

### 1. Push to GitHub
```bash
git init
git add .
git commit -m "Initial Lumi backend"
# Create a new repo on github.com, then:
git remote add origin https://github.com/YOUR_USERNAME/lumi-backend.git
git push -u origin main
```

### 2. Deploy on Railway
1. Go to [railway.app](https://railway.app) and sign up (free)
2. Click **New Project → Deploy from GitHub repo**
3. Select your `lumi-backend` repo
4. Railway auto-detects Node.js and deploys it

### 3. Add your API key
1. In Railway, click your project → **Variables**
2. Add: `ANTHROPIC_API_KEY` = your key from console.anthropic.com
3. Railway auto-redeploys with the new variable

### 4. Get your URL
Railway gives you a URL like `https://lumi-backend-production.up.railway.app`
Copy this — you'll paste it into the Chrome extension.

---

## API Endpoints

### `GET /`
Health check.
```json
{ "status": "ok", "service": "Lumi API", "version": "1.0.0" }
```

### `POST /register`
Register a new user. Call once on extension install.
```json
// Response
{ "userId": "uuid-here", "message": "Welcome to Lumi!" }
```

### `GET /usage/:userId`
Check a user's monthly usage.
```json
{
  "userId": "...",
  "analysesThisMonth": 4,
  "resetsAt": "2026-06-01T00:00:00.000Z",
  "plan": "free"
}
```

### `POST /analyze`
Run a stock analysis.
```json
// Request
{ "ticker": "AAPL", "userId": "uuid-here" }

// Response
{
  "success": true,
  "ticker": "AAPL",
  "analysis": {
    "sentiment": "Bullish",
    "confidence": "High",
    "outlook": "...",
    "metrics": [...],
    "analysts": {...},
    "news": [...],
    "risks": [...]
  }
}
```

---

## Local Development
```bash
cp .env.example .env
# Add your ANTHROPIC_API_KEY to .env
npm install
npm run dev
```

---

## Coming Soon
- Stripe billing for premium plans
- PostgreSQL for persistent user data
- Usage analytics dashboard
