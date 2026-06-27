const POLL_INTERVAL_MINUTES = 1;
const DELAY_BETWEEN_SCRAPES_MS = 4000;

var browserAPI = typeof browserAPI !== 'undefined' ? browserAPI : (typeof browser !== 'undefined' ? browser : chrome);

let apiBase = '';
let jwtToken = '';

console.log('[ML Tracker] Background script initialized successfully.');

// Live status variables for the popup dashboard
let currentStatus = 'idle'; // 'idle' | 'fetching' | 'scraping' | 'submitting' | 'auth_error' | 'network_error'
let currentJobUrl = '';
let pendingJobsCount = 0;

function getStorage(keys) {
  return new Promise((resolve) => {
    try {
      if (typeof browser !== 'undefined' && browser.storage && browser.storage.local) {
        browser.storage.local.get(keys)
          .then((res) => resolve(res || {}))
          .catch(() => resolve({}));
      } else if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(keys, (res) => {
          resolve(res || {});
        });
      } else {
        resolve({});
      }
    } catch (e) {
      resolve({});
    }
  });
}

function setStorage(data) {
  return new Promise((resolve) => {
    try {
      if (typeof browser !== 'undefined' && browser.storage && browser.storage.local) {
        browser.storage.local.set(data)
          .then(() => resolve(true))
          .catch(() => resolve(false));
      } else if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set(data, () => {
          resolve(true);
        });
      } else {
        resolve(false);
      }
    } catch (e) {
      resolve(false);
    }
  });
}

async function getStoredConfig() {
  const stored = await getStorage(['apiBase', 'jwtToken']);
  if (stored.apiBase) apiBase = stored.apiBase;
  if (stored.jwtToken) jwtToken = stored.jwtToken;
}

function showNotification(title, message) {
  try {
    browserAPI.notifications.create(null, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: title,
      message: message,
      priority: 1
    });
  } catch (e) {
    console.warn('[ML Tracker] Notifications API error:', e.message);
  }
}

function setExtensionBadge(text, color) {
  try {
    const actionAPI = browserAPI.action || browserAPI.browserAction;
    if (actionAPI) {
      actionAPI.setBadgeText({ text });
      if (text) {
        actionAPI.setBadgeBackgroundColor({ color });
      }
    }
  } catch (e) {
    console.warn('[ML Tracker] Badge API error:', e.message);
  }
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
      currentStatus = 'auth_error';
      setExtensionBadge('!', '#ef4444');
      return [];
    }

    if (!res.ok) {
      const body = await res.text();
      console.error('[ML Tracker] Failed to fetch jobs:', res.status, body);
      currentStatus = 'network_error';
      setExtensionBadge('ERR', '#f59e0b');
      return [];
    }

    setExtensionBadge('', '#000000');
    const data = await res.json();
    return data.jobs || [];
  } catch (err) {
    console.error('[ML Tracker] Network error fetching jobs:', err.message);
    currentStatus = 'network_error';
    setExtensionBadge('ERR', '#f59e0b');
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

  currentStatus = 'fetching';
  const jobs = await fetchJobs();
  pendingJobsCount = jobs.length;

  if (jobs.length === 0) {
    if (currentStatus !== 'auth_error' && currentStatus !== 'network_error') {
      currentStatus = 'idle';
    }
    return;
  }

  console.log(`[ML Tracker] Found ${jobs.length} pending scrape jobs`);

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    pendingJobsCount = jobs.length - i;
    currentStatus = 'scraping';
    currentJobUrl = job.url;

    try {
      console.log(`[ML Tracker] Scraping ${job.announcementId}: ${job.url}`);
      const scraped = await scrapeListing(job.url, job.type);

      currentStatus = 'submitting';
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

  currentStatus = 'done';
  currentJobUrl = '';
  pendingJobsCount = 0;
  
  showNotification('Sincronização Concluída', `Coleta realizada com sucesso para ${jobs.length} produto(s).`);
  
  // Set back to idle after a few seconds
  setTimeout(() => {
    if (currentStatus === 'done') currentStatus = 'idle';
  }, 4000);
}

async function trackProductFromUrl(url) {
  await getStoredConfig();
  if (!jwtToken || !apiBase) {
    console.error('[ML Tracker] Context menu click failed: No configuration found.');
    showNotification('Configuração necessária', 'Abra o site do Price Tracker para conectar a extensão antes de rastrear.');
    return;
  }
  
  console.log(`[ML Tracker] Context menu tracking URL: ${url}`);
  try {
    const res = await fetch(`${apiBase}/api/products/track`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${jwtToken}`
      },
      body: JSON.stringify({ url })
    });
    
    const data = await res.json();
    if (res.ok) {
      console.log('[ML Tracker] Context menu track response:', data.message);
      showNotification('Produto Adicionado!', 'O anúncio foi adicionado ao seu painel. A extensão irá coletar os dados em instantes.');
      // Instantly trigger processJobs to scrape the new pending skeleton
      processJobs().catch(e => console.error('[ML Tracker] Context menu sync trigger error:', e));
    } else {
      console.error('[ML Tracker] Context menu track failed:', data.error);
      showNotification('Erro ao Rastrear', data.error || 'Erro desconhecido');
    }
  } catch (err) {
    console.error('[ML Tracker] Context menu track network error:', err.message);
    showNotification('Erro de Rede', 'Não foi possível conectar ao servidor.');
  }
}

function createContextMenu() {
  try {
    browserAPI.contextMenus.create({
      id: "track-ml-product",
      title: "Rastrear Preço deste Produto",
      contexts: ["page"],
      documentUrlPatterns: [
        "*://*.mercadolivre.com.br/*",
        "*://produto.mercadolivre.com.br/*"
      ]
    }, () => {
      if (browserAPI.runtime.lastError) {
        // Ignore if already exists
      }
    });
  } catch (e) {
    // Ignore context menu errors if not supported in this context
  }
}

// Alarms Scheduler
try {
  browserAPI.alarms.create('scrapePoll', { periodInMinutes: POLL_INTERVAL_MINUTES });
} catch (e) {
  console.warn('[ML Tracker] Alarms scheduling error:', e.message);
}

try {
  browserAPI.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'scrapePoll') {
      processJobs().catch(err => console.error('[ML Tracker] processJobs error:', err));
    }
  });
} catch (e) {}

try {
  browserAPI.runtime.onInstalled.addListener(() => {
    console.log('[ML Tracker] Extension installed. Polling started.');
    createContextMenu();
    processJobs().catch(err => console.error('[ML Tracker] Initial processJobs error:', err));
  });
} catch (e) {}

try {
  browserAPI.runtime.onStartup.addListener(() => {
    createContextMenu();
  });
} catch (e) {}

try {
  browserAPI.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === "track-ml-product" && tab.url) {
      trackProductFromUrl(tab.url).catch(e => console.error('[ML Tracker] Context menu click error:', e));
    }
  });
} catch (e) {}

browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'AUTO_CONFIG') {
    if (message.apiBase && message.jwtToken) {
      apiBase = message.apiBase;
      jwtToken = message.jwtToken;
      setStorage({ apiBase, jwtToken });
      console.log('[ML Tracker] Auto-configured from', apiBase);
      setExtensionBadge('', '#000000');
    }
    return false;
  }

  if (message.type === 'GET_CONFIG') {
    getStoredConfig()
      .catch(err => {
        console.error('[ML Tracker] GET_CONFIG storage fetch error:', err.message);
      })
      .finally(() => {
        sendResponse({ apiBase, hasJwt: !!jwtToken });
      });
    return true;
  }

  if (message.type === 'SET_CONFIG') {
    if (message.apiBase) apiBase = message.apiBase;
    if (message.jwtToken) jwtToken = message.jwtToken;
    setStorage({ apiBase, jwtToken })
      .then(() => {
        sendResponse({ ok: true });
      })
      .catch(err => {
        console.error('[ML Tracker] SET_CONFIG storage set error:', err.message);
        sendResponse({ ok: false, error: err.message });
      });
    return true;
  }

  if (message.type === 'TRIGGER_NOW') {
    processJobs()
      .catch(err => console.error('[ML Tracker] Manual trigger error:', err))
      .finally(() => {
        sendResponse({ ok: true });
      });
    return true;
  }

  if (message.type === 'GET_STATUS') {
    getStoredConfig()
      .catch(err => {
        console.error('[ML Tracker] GET_STATUS storage fetch error:', err.message);
      })
      .finally(() => {
        sendResponse({
          status: currentStatus,
          currentJobUrl: currentJobUrl,
          pendingCount: pendingJobsCount,
          apiConnected: !!jwtToken && !!apiBase,
          apiBase: apiBase
        });
      });
    return true;
  }
});

// Import scraping engine logic
if (typeof importScripts !== 'undefined') {
  importScripts('scraper.js');
}
