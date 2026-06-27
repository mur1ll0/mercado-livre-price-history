const apiBaseInput = document.getElementById('apiBaseInput');
const jwtInput = document.getElementById('jwtInput');
const saveBtn = document.getElementById('saveBtn');
const triggerBtn = document.getElementById('triggerBtn');
const clearBtn = document.getElementById('clearBtn');
const configSection = document.getElementById('configSection');
const toggleConfig = document.getElementById('toggleConfig');
const logsBtn = document.getElementById('logsBtn');

const serverConnectionEl = document.getElementById('serverConnectionEl');
const scraperStateBadge = document.getElementById('scraperStateBadge');
const pendingCountEl = document.getElementById('pendingCountEl');
const activeJobUrlEl = document.getElementById('activeJobUrlEl');

var browserAPI = typeof browserAPI !== 'undefined' ? browserAPI : (typeof browser !== 'undefined' ? browser : chrome);

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

// Toggle config section
toggleConfig.addEventListener('click', function() {
  configSection.classList.toggle('hidden');
});

// Open Logs Console in a new tab
logsBtn.addEventListener('click', function() {
  browserAPI.tabs.create({ url: 'logs.html' });
});

async function getTokenFromActiveTab() {
  try {
    const tabs = await browserAPI.tabs.query({ active: true, currentWindow: true });
    if (!tabs || !tabs.length) return null;
    const tab = tabs[0];
    if (!tab.url || !tab.url.startsWith('http')) return null;

    let token = null;
    let origin = null;

    if (browserAPI.scripting && browserAPI.scripting.executeScript) {
      const results = await browserAPI.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => localStorage.getItem('ml_token'),
      });
      if (results && results[0] && results[0].result) {
        token = results[0].result;
        origin = new URL(tab.url).origin;
      }
    } else if (browserAPI.tabs && browserAPI.tabs.executeScript) {
      // Fallback for Manifest V2 / Safari / Firefox legacy compatibility
      const results = await new Promise((resolve) => {
        try {
          browserAPI.tabs.executeScript(tab.id, {
            code: "localStorage.getItem('ml_token')"
          }, resolve);
        } catch (e) {
          resolve(null);
        }
      });
      if (results && results[0]) {
        token = results[0];
        origin = new URL(tab.url).origin;
      }
    }

    if (token && origin) {
      return { token, origin };
    }
    return null;
  } catch (err) {
    console.error('[ML Tracker] Failed to read active tab localStorage:', err.message);
    return null;
  }
}

// Function to update the popup status fields based on background script state
async function updateLiveStatus() {
  try {
    const status = await browserAPI.runtime.sendMessage({ type: 'GET_STATUS' });
    
    // 1. Server Connection Status
    if (status.apiConnected) {
      const hostname = new URL(status.apiBase).hostname;
      serverConnectionEl.innerHTML = `<span class="connected-dot pulse"></span> Conectado a ${hostname}`;
    } else {
      serverConnectionEl.innerHTML = `<span class="connected-dot disconnected"></span> Desconectado`;
    }

    // 2. Scraper State Badge
    let badgeClass = 'badge-warning';
    let badgeText = 'Carregando';

    switch(status.status) {
      case 'idle':
        badgeClass = 'badge-success';
        badgeText = 'Ocioso';
        break;
      case 'fetching':
        badgeClass = 'badge-info';
        badgeText = 'Buscando Jobs';
        break;
      case 'scraping':
        badgeClass = 'badge-warning';
        badgeText = 'Coletando';
        break;
      case 'submitting':
        badgeClass = 'badge-info';
        badgeText = 'Enviando Dados';
        break;
      case 'auth_error':
        badgeClass = 'badge-error';
        badgeText = 'Sessão Expirada';
        break;
      case 'network_error':
        badgeClass = 'badge-error';
        badgeText = 'Falha de Rede';
        break;
      case 'done':
        badgeClass = 'badge-success';
        badgeText = 'Concluído!';
        break;
    }

    scraperStateBadge.className = `badge ${badgeClass}`;
    scraperStateBadge.textContent = badgeText;

    // 3. Pending Count
    pendingCountEl.textContent = status.pendingCount || '0';

    // 4. Active Job URL
    if (status.status === 'scraping' && status.currentJobUrl) {
      activeJobUrlEl.classList.remove('hidden');
      try {
        const urlObj = new URL(status.currentJobUrl);
        activeJobUrlEl.textContent = `Coletando: ${urlObj.pathname}`;
      } catch (e) {
        activeJobUrlEl.textContent = `Coletando: ${status.currentJobUrl}`;
      }
    } else {
      activeJobUrlEl.classList.add('hidden');
    }
  } catch (err) {
    // Background worker might be sleeping/not responding yet
    scraperStateBadge.className = 'badge badge-warning';
    scraperStateBadge.textContent = 'Aguardando SW';
  }
}

async function loadConfig() {
  try {
    const stored = await browserAPI.runtime.sendMessage({ type: 'GET_CONFIG' });

    // Always try to detect from the active tab first (most reliable)
    const detected = await getTokenFromActiveTab();

    if (detected && detected.token && detected.origin) {
      await browserAPI.runtime.sendMessage({
        type: 'SET_CONFIG',
        apiBase: detected.origin,
        jwtToken: detected.token
      });
      apiBaseInput.value = detected.origin;
      jwtInput.value = '••••••••••••••••••••••';
      await updateLiveStatus();
      return;
    }

    // Fallback: show stored config
    if (stored.apiBase) {
      apiBaseInput.value = stored.apiBase;
      if (stored.hasJwt) {
        jwtInput.value = '••••••••••••••••••••••';
      }
    }
    
    await updateLiveStatus();
  } catch (err) {
    console.error('Error loading extension config:', err);
  }
}

saveBtn.addEventListener('click', async () => {
  const apiBase = apiBaseInput.value.trim().replace(/\/+$/, '');
  const jwtRaw = jwtInput.value.trim();
  const isMasked = jwtRaw === '••••••••••••••••••••••';

  if (!apiBase) { 
    alert('A URL da API é obrigatória.');
    return; 
  }

  let jwtToken;
  if (isMasked) {
    const detected = await getTokenFromActiveTab();
    jwtToken = detected ? detected.token : null;
    if (!jwtToken) {
      const stored = await getStorage('jwtToken');
      jwtToken = stored.jwtToken;
    }
  } else {
    jwtToken = jwtRaw;
  }

  if (!jwtToken) {
    alert(`Por favor, faça login em ${apiBase} primeiro no seu navegador, depois configure a extensão.`);
    return;
  }

  await browserAPI.runtime.sendMessage({ type: 'SET_CONFIG', apiBase, jwtToken });
  jwtInput.value = '••••••••••••••••••••••';
  
  // Instantly poll status
  await updateLiveStatus();
  alert('Configurações salvas com sucesso!');
});

triggerBtn.addEventListener('click', async () => {
  let conf = await browserAPI.runtime.sendMessage({ type: 'GET_CONFIG' });
  if (!conf.hasJwt) {
    const detected = await getTokenFromActiveTab();
    if (detected && detected.token) {
      await browserAPI.runtime.sendMessage({ type: 'SET_CONFIG', apiBase: detected.origin, jwtToken: detected.token });
      conf = await browserAPI.runtime.sendMessage({ type: 'GET_CONFIG' });
    }
  }

  if (!conf.hasJwt) {
    alert('JWT Token não configurado. Por favor, acesse o painel web da aplicação e faça login.');
    return;
  }

  await browserAPI.runtime.sendMessage({ type: 'TRIGGER_NOW' });
  
  // Instantly reflect state change
  await updateLiveStatus();
});

clearBtn.addEventListener('click', async () => {
  if (confirm('Tem certeza que deseja limpar as configurações da extensão?')) {
    await browserAPI.runtime.sendMessage({ type: 'SET_CONFIG', apiBase: '', jwtToken: '' });
    await setStorage({ logs: [] });
    apiBaseInput.value = '';
    jwtInput.value = '';
    await updateLiveStatus();
    alert('Dados da extensão resetados.');
  }
});

// Initialize and start live status polling
loadConfig();
const statusInterval = setInterval(updateLiveStatus, 1000);

// Stop interval when popup closes to save resources
window.addEventListener('unload', () => {
  clearInterval(statusInterval);
});
