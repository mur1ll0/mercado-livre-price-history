# AGENTS.md

## Project Overview

Mercado Livre price tracker with AI-based product deduplication. Node.js/Express + MongoDB + Puppeteer scraper + Browser Extensions (Chrome/Firefox). Deployed on Vercel.

## Commands

```bash
npm run dev           # Start local server (node src/server.js)
npm run test-scraper  # Test scraper against hardcoded URLs
npm start             # Same as dev (production start)
npm run clean-db      # Drop all MongoDB collections (fresh start)
npm run build         # Package extensions as ZIP files
```

## Entry Points

- **Local dev:** `src/server.js` — loads dotenv, connects DB, starts Express on `PORT` (default 3000)
- **Vercel:** `api/index.js` — serverless handler wrapping `src/app.js`
- **Cron/scraper:** `src/cron-scraper.js` — standalone Puppeteer scraper (legacy, extension-based scraping is primary now)
- **Extension Chrome:** `extensions/chrome/` — Manifest V3, service worker background, content script for auto-config
- **Extension Firefox:** `extensions/firefox/` — Manifest V2, background page, tab-based token detection

## Environment Variables

| Variable | Notes |
|---|---|
| `MONGODB_URI` | Takes precedence over `MONGO_URI` |
| `JWT_SECRET` | Hardcoded fallback `'fallback-jwt-secret-key-local'` |
| `GOOGLE_CLIENT_ID` | Required for auth |
| `OPENROUTER_API_KEY` | Required for AI product matching |
| `VERCEL` | Set automatically by Vercel; used to detect serverless vs local mode |

## Architecture

### Scraping Pipeline (Extension-based)

Primary scraping flow — works on localhost and Vercel:

```
POST /api/products/scrape → marks announcements as scrapeStatus='pending'
   ↓
Extension polls GET /api/scrape/jobs (every 60s via chrome.alarms)
   ↓
For each pending job: fetch(ML URL) with credentials:'include' (real browser cookies)
   ↓
DOMParser → extract price, seller, installments, shipping, deliveryDate
   ↓
POST /api/scrape/data → processScrapedAnnouncement() saves to MongoDB
   ↓
Frontend polls GET /api/scrape/status → auto-reloads when done
```

### Extension Scraper (`extensions/*/scraper.js`)

Same extraction logic as `src/scraper.js` but adapted for browser DOM APIs:
- Uses `DOMParser` instead of Cheerio
- `fetch()` with `credentials: 'include'` for browser cookies
- Browser-like headers (`sec-ch-ua`, `User-Agent` Chrome 120)
- Bot detection: checks URL redirects, page title, captcha text

### /s Fallback for Catalog Installments

When catalog BEST_INSTALLMENTS has no price, or BEST_PRICE has no installments:
1. Navigate to `/p/MLB.../s?page=1` (search results page)
2. Find `<span>` containing seller name
3. Climb to ancestor element
4. Extract installments from `[class*="ui-pdp-payment"]` div: `<span>` for quantity + `<span data-testid="price-part">` for amount
5. Extract delivery from `[class*="ui-pdp-shipping"]` div
6. Paginate up to 3 pages if not found

### Delivery Date Extraction

`extractDeliveryInfo()` — priority order:
1. `"entre X e Y/mmm"` format (e.g., "entre 27 e 28/jul" → 28/jul)
2. Single date `"X/mmm"` or `"X de mmm"`
3. `"X dias"` — relative days
4. `"amanhã"` / `"hoje"`
5. Weekday names (e.g., "segunda-feira")

Extraction searches for elements containing "Chegará" text, preferring ones with "grátis".

### Catalog Pages

- Catalog URLs (`/p/MLB...`) are detected by `parseMercadoLivreUrl`
- Base page is scraped first (respects `pdp_filters` for bookmarks)
- Variant URLs `?offer_type=BEST_PRICE` and `?offer_type=BEST_INSTALLMENTS` are fetched for additional offers
- If base page has no real offer list (bookmark-filtered), treats as `type: 'normal'`
- Announcement stores `offers.BEST_PRICE` and `offers.BEST_INSTALLMENTS` with full offer data including `deliveryDate`

### Announcement Model

- `_id`: string (MLB/MLBU IDs)
- `type`: `'catalog'` | `'normal'` — auto-detected from page structure
- `scrapeStatus`: `null` | `'pending'` | `'done'` — drives extension job queue
- `offers`: for catalog type, contains `BEST_PRICE` and `BEST_INSTALLMENTS` sub-documents
- `deliveryDate`: parsed delivery date (no raw `deliveryTime` stored)
- `url`: always stored clean (no `offer_type` param, no hash)

### Extension Auto-Configuration

Two methods:
1. **Content script** (`content-script.js`): injected into app pages, reads `localStorage('ml_token')` + `window.location.origin`, sends to background
2. **Popup tab detection** (`popup.js`): uses `chrome.scripting.executeScript` / `browser.tabs.executeScript` to read token from active tab's localStorage

### Frontend Status Polling

- `startStatusPolling()` called after tracking a product or clicking "Atualizar Preços"
- Polls `GET /api/scrape/status` every 2 seconds
- Shows animated banner: `needs_login` | `running` | `done` | `error`
- On `done`: auto-reloads dashboard (`loadDashboardData()`)
- Status `done` persists in memory for 10 minutes (TTL)

### Product Deduplication (`src/services/ai-matcher.js`)

Two-tier: Jaccard similarity → OpenRouter LLM (`meta-llama/llama-3-8b-instruct`)

### MongoDB DNS Quirk

`src/db.js` forces IPv4 DNS with Google DNS servers for Atlas connectivity on Windows.

## Extension Files Structure

```
extensions/
├── chrome/
│   ├── manifest.json        # MV3
│   ├── background.js        # Service worker — poll + orchestrate
│   ├── scraper.js           # DOM-based extraction
│   ├── content-script.js    # Auto-detect JWT from app pages
│   ├── popup.html/js        # Status + manual config
│   └── icons/
├── firefox/
│   ├── manifest.json        # MV2 with browser_specific_settings
│   ├── background.js        # Background page
│   ├── scraper.js           # Same as Chrome
│   ├── content-script.js    # Firefox variant (browser.* API)
│   ├── popup.html/js        # Tab-based token detection
│   └── icons/
├── generate-icons.cjs       # PNG icon generator
└── package.cjs              # Cross-platform ZIP packager
```

## Debug Scripts

- `src/test-openrouter.js` — Test OpenRouter API connection
- `src/debug-s-fallback.js` — Inspect /s page DOM structure
- `src/test-buybox-html.js` — Dump buybox element structure
- `src/test-bookmark-scrape.js` — Test scraping with bookmarks
- `src/test-page-prices.js` — List all prices/sellers on a page
- `scratch_inspect_links.js` — Generic HTML inspector
