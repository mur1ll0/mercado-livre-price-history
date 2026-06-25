const apiBaseInput = document.getElementById('apiBaseInput');
const jwtInput = document.getElementById('jwtInput');
const statusEl = document.getElementById('statusEl');
const saveBtn = document.getElementById('saveBtn');
const triggerBtn = document.getElementById('triggerBtn');
const clearBtn = document.getElementById('clearBtn');
const configSection = document.getElementById('configSection');
const toggleConfig = document.getElementById('toggleConfig');

function showStatus(msg, type) {
  statusEl.innerHTML = msg;
  statusEl.className = `status status-${type}`;
  statusEl.classList.remove('hidden');
}

toggleConfig.addEventListener('click', function() {
  configSection.classList.toggle('hidden');
});

async function getTokenFromActiveTab() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs || !tabs.length) return null;
    const tab = tabs[0];
    if (!tab.url || !tab.url.startsWith('http')) return null;

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => localStorage.getItem('ml_token'),
    });
    if (results && results[0] && results[0].result) {
      return { token: results[0].result, origin: new URL(tab.url).origin };
    }
    return null;
  } catch (err) {
    console.error('[ML Tracker] Failed to read localStorage:', err.message);
    return null;
  }
}

async function loadConfig() {
  try {
    const stored = await chrome.runtime.sendMessage({ type: 'GET_CONFIG' });

    // Always try to detect from the active tab first (most reliable)
    showStatus('Detectando da aba ativa...', 'warn');
    const detected = await getTokenFromActiveTab();

    if (detected && detected.token && detected.origin) {
      await chrome.runtime.sendMessage({
        type: 'SET_CONFIG',
        apiBase: detected.origin,
        jwtToken: detected.token
      });
      apiBaseInput.value = detected.origin;
      jwtInput.value = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';
      showStatus(`<span class="connected-dot"></span> Conectado a ${detected.origin}`, 'ok');
      return;
    }

    // Fallback: show stored config
    if (stored.apiBase) {
      apiBaseInput.value = stored.apiBase;
      if (stored.hasJwt) {
        jwtInput.value = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';
        showStatus(`URL salva: ${stored.apiBase}. Abra o site para atualizar o token.`, 'warn');
      } else {
        showStatus(`URL salva: ${stored.apiBase}. Faça login no site.`, 'warn');
      }
    } else {
      showStatus('Abra http://localhost:3000, faça login, e abra este popup.', 'warn');
    }
  } catch (err) {
    showStatus('Erro ao carregar configuração', 'err');
  }
}

saveBtn.addEventListener('click', async () => {
  const apiBase = apiBaseInput.value.trim().replace(/\/+$/, '');
  const jwtRaw = jwtInput.value.trim();
  const isMasked = jwtRaw === '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';

  if (!apiBase) { showStatus('URL da API é obrigatória', 'err'); return; }

  let jwtToken;
  if (isMasked) {
    const detected = await getTokenFromActiveTab();
    jwtToken = detected ? detected.token : null;
  } else {
    jwtToken = jwtRaw;
  }

  if (!jwtToken) {
    showStatus(`Faça login em ${apiBase} primeiro, depois clique em Salvar.`, 'err');
    return;
  }

  await chrome.runtime.sendMessage({ type: 'SET_CONFIG', apiBase, jwtToken });
  showStatus(`Conectado a ${apiBase}!`, 'ok');
  jwtInput.value = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';
});

triggerBtn.addEventListener('click', async () => {
  let conf = await chrome.runtime.sendMessage({ type: 'GET_CONFIG' });
  if (!conf.hasJwt) {
    const detected = await getTokenFromActiveTab();
    if (detected && detected.token) {
      await chrome.runtime.sendMessage({ type: 'SET_CONFIG', apiBase: detected.origin, jwtToken: detected.token });
      conf = await chrome.runtime.sendMessage({ type: 'GET_CONFIG' });
    }
  }

  if (!conf.hasJwt) {
    showStatus('JWT não configurado. Abra o site, faça login, e abra o popup de novo.', 'warn');
    return;
  }

  await chrome.runtime.sendMessage({ type: 'TRIGGER_NOW' });
  showStatus('Disparado! Verificando jobs...', 'warn');

  setTimeout(async () => {
    try {
      const res = await fetch(`${conf.apiBase}/api/scrape/jobs`, {
        headers: { 'Authorization': 'Bearer ' + conf.jwtToken }
      });
      const data = await res.json();
      if (res.ok) {
        const n = data.jobs?.length || 0;
        showStatus(n > 0
          ? `${n} job(s) pendente(s). A extensão irá processar.`
          : 'Nenhum job pendente. Clique "Atualizar Preços" no site.', 'ok');
      } else {
        showStatus(`Erro HTTP ${res.status} ao buscar jobs`, 'err');
      }
    } catch (e) {
      showStatus('Verifique o console (F12)', 'warn');
    }
  }, 2000);
});

clearBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'SET_CONFIG', apiBase: '', jwtToken: '' });
  apiBaseInput.value = '';
  jwtInput.value = '';
  showStatus('Limpo. Abra o site para reconfigurar.', 'warn');
});

loadConfig();
