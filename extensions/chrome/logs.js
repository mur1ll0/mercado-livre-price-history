const consoleBox = document.getElementById('consoleBox');
const refreshBtn = document.getElementById('refreshBtn');
const exportBtn = document.getElementById('exportBtn');
const clearBtn = document.getElementById('clearBtn');

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

function getLogs() {
  return getStorage('logs').then(stored => {
    if (stored && Array.isArray(stored.logs)) {
      return stored.logs;
    }
    if (stored && Array.isArray(stored)) {
      return stored;
    }
    return [];
  });
}

function clearLogs() {
  return setStorage({ logs: [] });
}

async function renderLogs() {
  try {
    const logs = await getLogs();

    if (logs.length === 0) {
      consoleBox.innerHTML = '<div class="empty-logs">Nenhum log registrado ainda.</div>';
      return;
    }

    consoleBox.innerHTML = '';
    
    logs.forEach(line => {
      const lineEl = document.createElement('div');
      lineEl.className = 'log-line';
      
      if (line.includes('[WARN]')) {
        lineEl.className += ' log-warn';
      } else if (line.includes('[ERROR]')) {
        lineEl.className += ' log-error';
      } else if (line.includes('[SYSTEM]')) {
        lineEl.className += ' log-system';
      } else {
        lineEl.className += ' log-info';
      }
      
      lineEl.textContent = line;
      consoleBox.appendChild(lineEl);
    });

    // Auto-scroll to bottom
    consoleBox.scrollTop = consoleBox.scrollHeight;
  } catch (err) {
    consoleBox.innerHTML = `<div class="log-line log-error">[ERRO] Falha ao carregar logs: ${err.message}</div>`;
  }
}

refreshBtn.addEventListener('click', renderLogs);

clearBtn.addEventListener('click', async () => {
  if (confirm('Deseja limpar todos os logs acumulados no console?')) {
    await clearLogs();
    await renderLogs();
  }
});

exportBtn.addEventListener('click', async () => {
  try {
    const logs = await getLogs();
    
    if (logs.length === 0) {
      alert('Nenhum log disponível para exportar.');
      return;
    }

    const blob = new Blob([logs.join('\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `ml_price_tracker_logs_${new Date().toISOString().split('T')[0]}.txt`;
    document.body.appendChild(a);
    a.click();
    
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  } catch (err) {
    alert(`Erro ao exportar logs: ${err.message}`);
  }
});

// Initial render
renderLogs();
