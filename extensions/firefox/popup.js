var apiBaseInput = document.getElementById('apiBaseInput');
var jwtInput = document.getElementById('jwtInput');
var statusEl = document.getElementById('statusEl');
var saveBtn = document.getElementById('saveBtn');
var triggerBtn = document.getElementById('triggerBtn');
var clearBtn = document.getElementById('clearBtn');
var configSection = document.getElementById('configSection');
var toggleConfig = document.getElementById('toggleConfig');

function showStatus(msg, type) {
  statusEl.innerHTML = msg;
  statusEl.className = 'status status-' + type;
  statusEl.classList.remove('hidden');
}

toggleConfig.addEventListener('click', function() {
  configSection.classList.toggle('hidden');
});

function getTokenFromActiveTab() {
  return browser.tabs.query({ active: true, currentWindow: true }).then(function(tabs) {
    if (!tabs || !tabs.length) return null;
    var tab = tabs[0];
    var url = tab.url || '';

    if (!url.startsWith('http')) return null;

    return browser.tabs.executeScript(tab.id, {
      code: 'localStorage.getItem("ml_token")'
    }).then(function(results) {
      if (results && results[0]) return { token: results[0], origin: new URL(url).origin };
      return null;
    }).catch(function(err) {
      console.error('[ML Tracker] Failed to read localStorage:', err.message);
      return null;
    });
  });
}

async function loadConfig() {
  var stored = await browser.runtime.sendMessage({ type: 'GET_CONFIG' });

  showStatus('Detectando da aba ativa...', 'warn');
  var detected = await getTokenFromActiveTab();

  if (detected && detected.token && detected.origin) {
    await browser.runtime.sendMessage({
      type: 'SET_CONFIG',
      apiBase: detected.origin,
      jwtToken: detected.token
    });
    apiBaseInput.value = detected.origin;
    jwtInput.value = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';
    showStatus('<span class="connected-dot"></span> Conectado a ' + detected.origin, 'ok');
    return;
  }

  if (stored.apiBase) {
    apiBaseInput.value = stored.apiBase;
    if (stored.hasJwt) {
      jwtInput.value = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';
      showStatus('URL salva: ' + stored.apiBase + '. Abra o site para atualizar o token.', 'warn');
    } else {
      showStatus('URL salva: ' + stored.apiBase + '. Faça login no site.', 'warn');
    }
  } else {
    showStatus('Abra http://localhost:3000, faça login, e abra este popup.', 'warn');
  }
}

saveBtn.addEventListener('click', async function() {
  var apiBase = apiBaseInput.value.trim().replace(/\/+$/, '');
  var jwtRaw = jwtInput.value.trim();
  var isMasked = jwtRaw.indexOf('\u2022') >= 0;

  if (!apiBase) { showStatus('URL da API é obrigatória', 'err'); return; }

  var jwtToken;
  if (isMasked) {
    var detected = await getTokenFromActiveTab();
    jwtToken = detected ? detected.token : null;
  } else {
    jwtToken = jwtRaw;
  }

  if (!jwtToken) {
    showStatus('Faça login em ' + apiBase + ' primeiro, depois clique em Salvar.', 'err');
    return;
  }

  await browser.runtime.sendMessage({ type: 'SET_CONFIG', apiBase: apiBase, jwtToken: jwtToken });
  showStatus('Conectado a ' + apiBase + '!', 'ok');
  jwtInput.value = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';
});

triggerBtn.addEventListener('click', async function() {
  var conf = await browser.runtime.sendMessage({ type: 'GET_CONFIG' });
  if (!conf.hasJwt) {
    var detected = await getTokenFromActiveTab();
    if (detected && detected.token) {
      await browser.runtime.sendMessage({ type: 'SET_CONFIG', apiBase: detected.origin, jwtToken: detected.token });
      conf = await browser.runtime.sendMessage({ type: 'GET_CONFIG' });
    }
  }

  if (!conf.hasJwt) {
    showStatus('JWT não configurado. Abra o site, faça login, e clique aqui de novo.', 'warn');
    return;
  }

  await browser.runtime.sendMessage({ type: 'TRIGGER_NOW' });
  showStatus('Disparado! Verificando jobs...', 'warn');

  setTimeout(async function() {
    try {
      var res = await fetch(conf.apiBase + '/api/scrape/jobs', {
        headers: { 'Authorization': 'Bearer ' + conf.jwtToken }
      });
      var data = await res.json();
      if (res.ok) {
        var n = data.jobs ? data.jobs.length : 0;
        showStatus(n > 0
          ? n + ' job(s) pendente(s). A extensão irá processar.'
          : 'Nenhum job pendente. Clique "Atualizar Preços" no site.', 'ok');
      } else {
        showStatus('Erro HTTP ' + res.status + ' ao buscar jobs', 'err');
      }
    } catch (e) {
      showStatus('Verifique o console (Ctrl+Shift+J)', 'warn');
    }
  }, 2000);
});

clearBtn.addEventListener('click', async function() {
  await browser.runtime.sendMessage({ type: 'SET_CONFIG', apiBase: '', jwtToken: '' });
  apiBaseInput.value = '';
  jwtInput.value = '';
  showStatus('Limpo. Abra o site para reconfigurar.', 'warn');
});

loadConfig();
