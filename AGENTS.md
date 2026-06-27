# AGENTS.md

## Project Overview

Mercado Livre price tracker with AI-based product deduplication. Node.js/Express + MongoDB + Puppeteer scraper + Browser Extensions (Chrome/Firefox). Deployed on Vercel. Extensions work both locally and via Vercel, with a MongoDB `scrapestatuses` collection for per-user scrape state tracking across serverless containers.

## Commands

```bash
npm run dev           # Start local server (node src/server.js)
npm run test-scraper  # Test scraper against hardcoded URLs
npm run test-openrouter # Test OpenRouter API connection
npm start             # Same as dev (production start)
npm run clean-db      # Drop all MongoDB collections (fresh start)
npm run build         # Sync Chrome→Firefox + package both as ZIP files
```

## Entry Points

- **Local dev:** `src/server.js` — loads dotenv, connects DB, starts Express on `PORT` (default 3000)
- **Vercel:** `api/index.js` — serverless handler wrapping `src/app.js`
- **Cron/scraper:** `src/cron-scraper.js` — standalone Puppeteer scraper (legacy, extension-based scraping is primary now)
- **Extension Chrome:** `extensions/chrome/` — Manifest V3, service worker background, content script for auto-config, ML page widget, live popup dashboard
- **Extension Firefox:** `extensions/firefox/` — Manifest V2, persistent background page, identical JS/HTML/CSS to Chrome (synced at build time)

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

### Scrape Status Tracking (`scrapestatuses` collection)

Replaces in-memory state with MongoDB-backed per-user tracking — survives Vercel serverless container restarts:

- **Model:** `src/models/ScrapeStatus.js` — `{ userId, state, message, updatedAt }`
- **Service:** `src/services/scrape-status.js` — `setScrapeStatus()` / `getScrapeStatus()`
- **States:** `idle` → `needs_login` → `running` → `done` | `error`
- Set to `running` on track/scrape actions, `done` when all jobs complete, `error` on failure
- Backend auto-fixes `idle` to `running` if pending announcements exist on status poll

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

### ML Page Widget (`ml-content-script.js`)

Injected into Mercado Livre product pages. Adds a "Ver Histórico de Preços" button that opens a modal with an iframe pointing to `/price-widget.html?url=...` — displays the tracked price history chart in-page.

### Extension Popup & Logs

- **Popup** (`popup.html`/`popup.js`): dark-themed live dashboard with scrape status, job progress, and manual config panel. Polls background every 1s via `GET_STATUS`.
- **Logs** (`logs.html`/`logs.js`): terminal-style viewer reading from `storage.local` (last 100 entries), supports refresh/export/clear.

### Frontend Status Polling

- `startStatusPolling()` called after tracking a product or clicking "Atualizar Preços"
- Polls `GET /api/scrape/status` every 2 seconds
- Shows animated banner: `needs_login` | `running` | `done` | `error`
- On `done`: auto-reloads dashboard (`loadDashboardData()`)
- Status is persisted in MongoDB `scrapestatuses` collection — survives serverless container restarts

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
│   ├── ml-content-script.js # ML page widget (price history button/modal)
│   ├── popup.html/js        # Live dashboard with scrape status
│   ├── logs.html/js         # Terminal-style logs viewer
│   └── icons/
├── firefox/
│   ├── manifest.json        # MV2 with browser_specific_settings
│   ├── background.js        # Persistent background page
│   ├── scraper.js           # Same as Chrome (synced at build)
│   ├── content-script.js    # Same as Chrome (synced at build)
│   ├── ml-content-script.js # Same as Chrome (synced at build)
│   ├── popup.html/js        # Same as Chrome (synced at build)
│   ├── logs.html/js         # Same as Chrome (synced at build)
│   └── icons/
├── generate-icons.cjs       # PNG icon generator
├── resize-logo.cjs          # Logo resizer for extension icons
└── package.cjs              # Cross-platform ZIP packager + Chrome→Firefox sync
```

## Debug Scripts

All debug scripts live in `test/`. See `test/README.md` for full list.

- `npm run test-openrouter` — Test OpenRouter API connection
- `npm run test-scraper` — Test Puppeteer scraper against hardcoded URLs
- `test/inspect-s-fallback.js` — Inspect /s page DOM structure
- `test/inspect-buybox.js` — Dump buybox element structure
- `test/inspect-bookmark.js` — Test scraping with bookmarks
- `test/inspect-page-prices.js` — List all prices/sellers on a page
- `test/inspect-links.js` — Generic HTML inspector for multiple URLs
