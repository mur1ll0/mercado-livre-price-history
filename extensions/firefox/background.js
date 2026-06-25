var POLL_INTERVAL_MINUTES = 1;
var DELAY_BETWEEN_SCRAPES_MS = 4000;

var apiBase = '';
var jwtToken = '';

function getStoredConfig() {
  return browser.storage.local.get(['apiBase', 'jwtToken']).then(function(stored) {
    if (stored.apiBase) apiBase = stored.apiBase;
    if (stored.jwtToken) jwtToken = stored.jwtToken;
  });
}

function fetchJobs() {
  if (!jwtToken) {
    console.log('[ML Tracker] No JWT token configured. Open extension popup to set up.');
    return Promise.resolve([]);
  }

  return fetch(apiBase + '/api/scrape/jobs', {
    headers: { 'Authorization': 'Bearer ' + jwtToken }
  }).then(function(res) {
    if (res.status === 401 || res.status === 403) {
      console.error('[ML Tracker] Auth failed. Please re-login and update JWT in extension popup.');
      return { jobs: [] };
    }
    if (!res.ok) {
      console.error('[ML Tracker] Failed to fetch jobs:', res.status);
      return { jobs: [] };
    }
    return res.json();
  }).then(function(data) {
    return data.jobs || [];
  }).catch(function(err) {
    console.error('[ML Tracker] Network error fetching jobs:', err.message);
    return [];
  });
}

function submitScrapedData(announcementId, data) {
  if (!jwtToken) return Promise.resolve(false);

  return fetch(apiBase + '/api/scrape/data', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + jwtToken
    },
    body: JSON.stringify({ announcementId: announcementId, data: data })
  }).then(function(res) {
    if (!res.ok) {
      return res.text().then(function(body) {
        console.error('[ML Tracker] Failed to submit data for ' + announcementId + ':', res.status, body);
        return false;
      });
    }
    console.log('[ML Tracker] Data submitted successfully for ' + announcementId);
    return true;
  }).catch(function(err) {
    console.error('[ML Tracker] Network error submitting data for ' + announcementId + ':', err.message);
    return false;
  });
}

function processJobs() {
  return getStoredConfig().then(function() {
    return fetchJobs();
  }).then(function(jobs) {
    if (jobs.length === 0) {
      return;
    }

    console.log('[ML Tracker] Found ' + jobs.length + ' pending scrape jobs');

    var chain = Promise.resolve();
    jobs.forEach(function(job) {
      chain = chain.then(function() {
        console.log('[ML Tracker] Scraping ' + job.announcementId + ': ' + job.url);

        return scrapeListing(job.url, job.type).then(function(scraped) {
          if (scraped) {
            return submitScrapedData(job.announcementId, scraped);
          } else {
            console.warn('[ML Tracker] Failed to scrape ' + job.announcementId);
            return submitScrapedData(job.announcementId, {
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
        }).then(function() {
          return new Promise(function(resolve) {
            setTimeout(resolve, DELAY_BETWEEN_SCRAPES_MS);
          });
        }).catch(function(err) {
          console.error('[ML Tracker] Error processing job ' + job.announcementId + ':', err.message);
        });
      });
    });

    return chain;
  }).catch(function(err) {
    console.error('[ML Tracker] processJobs error:', err);
  });
}

browser.alarms.create('scrapePoll', { periodInMinutes: POLL_INTERVAL_MINUTES });

browser.alarms.onAlarm.addListener(function(alarm) {
  if (alarm.name === 'scrapePoll') {
    processJobs();
  }
});

browser.runtime.onInstalled.addListener(function() {
  console.log('[ML Tracker] Extension installed. Polling started.');
  processJobs();
});

browser.runtime.onMessage.addListener(function(message, sender, sendResponse) {
  if (message.type === 'AUTO_CONFIG') {
    if (message.apiBase && message.jwtToken) {
      apiBase = message.apiBase;
      jwtToken = message.jwtToken;
      browser.storage.local.set({ apiBase: apiBase, jwtToken: jwtToken });
      console.log('[ML Tracker] Auto-configured from', apiBase);
    }
    return false;
  }

  if (message.type === 'GET_CONFIG') {
    getStoredConfig().then(function() {
      sendResponse({ apiBase: apiBase, hasJwt: !!jwtToken });
    });
    return true;
  }

  if (message.type === 'SET_CONFIG') {
    if (message.apiBase) apiBase = message.apiBase;
    if (message.jwtToken) jwtToken = message.jwtToken;
    browser.storage.local.set({ apiBase: apiBase, jwtToken: jwtToken }).then(function() {
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === 'TRIGGER_NOW') {
    processJobs();
    sendResponse({ ok: true });
    return true;
  }
});
