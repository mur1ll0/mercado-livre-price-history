const POLL_INTERVAL_MINUTES = 1;
const DELAY_BETWEEN_SCRAPES_MS = 4000;

let apiBase = '';
let jwtToken = '';

async function getStoredConfig() {
  const stored = await chrome.storage.local.get(['apiBase', 'jwtToken']);
  if (stored.apiBase) apiBase = stored.apiBase;
  if (stored.jwtToken) jwtToken = stored.jwtToken;
}

async function fetchJobs() {
  if (!jwtToken) {
    console.log('[ML Tracker] No JWT token configured. Open extension popup to set up.');
    return [];
  }

  try {
    const res = await fetch(`${apiBase}/api/scrape/jobs`, {
      headers: { 'Authorization': `Bearer ${jwtToken}` }
    });

    if (res.status === 401 || res.status === 403) {
      const body = await res.text();
      console.error('[ML Tracker] Auth failed (', res.status, '):', body);
      return [];
    }

    if (!res.ok) {
      const body = await res.text();
      console.error('[ML Tracker] Failed to fetch jobs:', res.status, body);
      return [];
    }

    const data = await res.json();
    return data.jobs || [];
  } catch (err) {
    console.error('[ML Tracker] Network error fetching jobs:', err.message);
    return [];
  }
}

async function submitScrapedData(announcementId, data) {
  if (!jwtToken) return false;

  try {
    const res = await fetch(`${apiBase}/api/scrape/data`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${jwtToken}`
      },
      body: JSON.stringify({ announcementId, data })
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`[ML Tracker] Failed to submit data for ${announcementId}:`, res.status, body);
      return false;
    }

    console.log(`[ML Tracker] Data submitted successfully for ${announcementId}`);
    return true;
  } catch (err) {
    console.error(`[ML Tracker] Network error submitting data for ${announcementId}:`, err.message);
    return false;
  }
}

async function processJobs() {
  await getStoredConfig();

  const jobs = await fetchJobs();
  if (jobs.length === 0) {
    return;
  }

  console.log(`[ML Tracker] Found ${jobs.length} pending scrape jobs`);

  for (const job of jobs) {
    try {
      console.log(`[ML Tracker] Scraping ${job.announcementId}: ${job.url}`);

      const scraped = await scrapeListing(job.url, job.type);

      if (scraped) {
        await submitScrapedData(job.announcementId, scraped);
      } else {
        console.warn(`[ML Tracker] Failed to scrape ${job.announcementId}`);
        await submitScrapedData(job.announcementId, {
          title: 'Falha ao coletar dados',
          type: job.type,
          isUnavailable: false,
          rating: null,
          reviewsCount: 0,
          aiSummary: '',
          categories: [],
          image: ''
        });
      }

      await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_SCRAPES_MS));
    } catch (err) {
      console.error(`[ML Tracker] Error processing job ${job.announcementId}:`, err.message);
    }
  }
}

chrome.alarms.create('scrapePoll', { periodInMinutes: POLL_INTERVAL_MINUTES });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'scrapePoll') {
    processJobs().catch(err => console.error('[ML Tracker] processJobs error:', err));
  }
});

chrome.runtime.onInstalled.addListener(() => {
  console.log('[ML Tracker] Extension installed. Polling started.');
  processJobs().catch(err => console.error('[ML Tracker] Initial processJobs error:', err));
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'AUTO_CONFIG') {
    if (message.apiBase && message.jwtToken) {
      apiBase = message.apiBase;
      jwtToken = message.jwtToken;
      chrome.storage.local.set({ apiBase, jwtToken });
      console.log('[ML Tracker] Auto-configured from', apiBase);
    }
    return false;
  }

  if (message.type === 'GET_CONFIG') {
    getStoredConfig().then(() => {
      sendResponse({ apiBase, hasJwt: !!jwtToken });
    });
    return true;
  }

  if (message.type === 'SET_CONFIG') {
    if (message.apiBase) apiBase = message.apiBase;
    if (message.jwtToken) jwtToken = message.jwtToken;
    chrome.storage.local.set({ apiBase, jwtToken }).then(() => {
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === 'TRIGGER_NOW') {
    processJobs().catch(err => console.error('[ML Tracker] Manual trigger error:', err));
    sendResponse({ ok: true });
    return true;
  }
});

importScripts('scraper.js');
