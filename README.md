# GST Scraper — Local Test Bed

Test scraping the GST portal locally before wiring into the app.

## Setup

```bash
cd D:\Claude\gst-scraper-local
npm install
npx playwright install chromium
cp .env.example .env
# Fill in GST_USERNAME and GST_PASSWORD in .env
```

## Workflow (in order)

### Step 1 — Login once (OTP required THIS TIME ONLY)
```bash
npm run login
```
- Browser opens visibly
- You fill credentials + solve CAPTCHA + enter OTP on phone
- Script detects dashboard redirect → saves session to `sessions/gst-session.json`
- **All future scripts use this saved session — zero OTP**

### Step 2 — Explore (MOST IMPORTANT — run this first)
```bash
npm run explore
```
- Visits every portal page with your saved session
- Logs EVERY internal API call the page makes
- Saves full map to `output/endpoint-map.json`
- **Read this file — it shows you exactly what data is available and which URLs to call**

### Step 3 — Check session health
```bash
npm run session:check
```

### Step 4 — Scrape specific data
```bash
npm run scrape:notices   # GST notices (DRC-01, ASMT-10, etc.)
npm run scrape:returns   # Return filing history
npm run scrape:ledger    # Cash / Credit / Liability ledger
```
All outputs → `output/` folder as JSON.

## What we learn from this

1. **Exact API endpoint URLs** the portal uses internally
2. **Exact JSON structure** of notices, returns, ledger data
3. **Which cookies/headers** are needed for direct HTTP calls
4. **Session duration** — how long before OTP is needed again
5. **Any anti-bot friction** we need to handle

Once we know all this → we replicate the HTTP calls directly with `axios`
(no browser needed for subsequent runs), then port to Railway microservice.

## File Structure

```
src/
  login.ts          ← one-time login, saves session
  explore.ts        ← maps all API endpoints (run first)
  session.ts        ← session save/load utilities
  browser.ts        ← Playwright launcher with stealth patches
  session-check.ts  ← verify session is still valid
  scrape-notices.ts ← fetch GST notices
  scrape-returns.ts ← fetch return history
  scrape-ledger.ts  ← fetch ledger balances

sessions/           ← live session cookies (gitignored!)
output/             ← scraped JSON output
```

## After testing works locally

Port to Railway:
1. Replace file-based sessions → Supabase `portal_sessions` table (AES encrypted)
2. Replace console logs → structured JSON responses
3. Add BullMQ job queue for bulk operations
4. Add retry logic + exponential backoff
5. Add session expiry push notifications
