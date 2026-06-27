(function() {
  const loadingScreen = document.getElementById('loadingScreen');
  const messageScreen = document.getElementById('messageScreen');
  const messageTitle = document.getElementById('messageTitle');
  const messageText = document.getElementById('messageText');
  const actionBtn = document.getElementById('actionBtn');
  const canvas = document.getElementById('widgetChart');

  const urlParams = new URLSearchParams(window.location.search);
  const productUrl = urlParams.get('url');

  const token = localStorage.getItem('ml_token');

  if (!productUrl) {
    showError('Parâmetro Ausente', 'Nenhuma URL de produto foi fornecida para o widget.');
    return;
  }

  const targetId = getMlbId(productUrl);
  if (!targetId) {
    showError('Link Inválido', 'Não foi possível extrair o ID do anúncio Mercado Livre a partir do link fornecido.');
    return;
  }

  if (!token) {
    showError('Login Requerido', 'Faça login no painel do Price History Tracker para visualizar o histórico de preços deste produto.', true);
    actionBtn.textContent = 'Acessar Painel';
    actionBtn.onclick = () => window.open(window.location.origin, '_blank');
    return;
  }

  // Load product history
  loadWidgetData();

  function getMlbId(urlString) {
    if (!urlString) return null;
    const match = urlString.match(/(MLB-?\d+)/i);
    if (match) return match[1].replace('-', '').toUpperCase();
    return null;
  }

  function showError(title, text, showButton = false) {
    loadingScreen.classList.add('hidden');
    messageScreen.classList.remove('hidden');
    messageTitle.textContent = title;
    messageText.textContent = text;
    if (showButton) {
      actionBtn.classList.remove('hidden');
    } else {
      actionBtn.classList.add('hidden');
    }
  }

  async function loadWidgetData(isRetry = false) {
    try {
      const res = await fetch('/api/products/ranked', {
        headers: { 'Authorization': `Bearer ${token}` }
      });

      if (res.status === 401 || res.status === 403) {
        localStorage.removeItem('ml_token');
        localStorage.removeItem('ml_user');
        showError('Sessão Expirada', 'Sua sessão expirou. Faça login novamente no painel.', true);
        actionBtn.textContent = 'Fazer Login';
        actionBtn.onclick = () => window.open(window.location.origin, '_blank');
        return;
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const products = await res.json();
      
      // Find matching announcements
      const matchingAnns = [];
      let foundProduct = null;

      for (const prod of products) {
        prod.announcements.forEach(ann => {
          const baseId = ann._id.split('_')[0];
          if (baseId === targetId) {
            matchingAnns.push(ann);
            foundProduct = prod;
          }
        });
      }

      if (matchingAnns.length === 0) {
        // If we just clicked track and are waiting/retrying
        if (isRetry) {
          console.log('[Widget] Still waiting for first scrape...');
          setTimeout(() => loadWidgetData(true), 2500); // retry
          return;
        }

        // Offer tracking option
        showError('Produto Não Rastreante', 'Você ainda não está rastreando este produto no sistema. Deseja iniciar o monitoramento?', true);
        actionBtn.textContent = 'Rastrear este Produto';
        actionBtn.onclick = () => startTracking();
        return;
      }

      // We found the product! Render chart
      loadingScreen.classList.add('hidden');
      messageScreen.classList.add('hidden');
      renderChart(matchingAnns);

    } catch (err) {
      showError('Erro de Conexão', `Não foi possível obter dados do servidor: ${err.message}`);
    }
  }

  async function startTracking() {
    loadingScreen.classList.remove('hidden');
    messageScreen.classList.add('hidden');
    document.querySelector('#loadingScreen p').textContent = 'Iniciando rastreamento...';

    try {
      const res = await fetch('/api/products/track', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ url: productUrl })
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      document.querySelector('#loadingScreen p').textContent = 'Acionando extensão local...';

      // Instantly tell extension in parent window to sync
      window.parent.postMessage({
        type: 'ML_TRIGGER_SCRAPE_NOW',
        source: 'ml-price-tracker-web'
      }, '*');

      document.querySelector('#loadingScreen p').textContent = 'Coletando dados iniciais do anúncio...';

      // Start polling until the background worker scrapes it
      setTimeout(() => loadWidgetData(true), 2000);

    } catch (err) {
      showError('Erro ao Rastrear', `Falha ao adicionar produto: ${err.message}`);
    }
  }

  function renderChart(announcements) {
    const ctx = canvas.getContext('2d');
    
    // Group all history data points
    const datasets = [];
    const colorPalette = ['#a78bfa', '#34d399', '#f59e0b', '#3b82f6'];

    announcements.forEach((ann, idx) => {
      const history = ann.priceHistory || [];
      if (history.length === 0) return;

      const color = colorPalette[idx % colorPalette.length];
      const isCatalog = ann.type === 'catalog';

      // Label description
      let label = ann.title;
      if (isCatalog) {
        if (ann._id.includes('BEST_PRICE')) label += ' (Melhor Preço)';
        else if (ann._id.includes('BEST_INSTALLMENTS')) label += ' (Sem Juros)';
      }

      // Cash price dataset
      const cashPoints = history.map(h => ({ x: h.date, y: h.price })).filter(pt => pt.y != null);
      if (cashPoints.length > 0) {
        datasets.push({
          label: label,
          data: cashPoints,
          borderColor: color,
          backgroundColor: 'transparent',
          borderWidth: 2.5,
          pointBackgroundColor: '#fff',
          pointBorderColor: color,
          pointHoverRadius: 6,
          pointRadius: 4,
          tension: 0.15,
          showLine: true
        });
      }

      // Installments price dataset (if available and not duplicated)
      const installmentPoints = history.map(h => ({ x: h.date, y: h.installmentsTotal })).filter(pt => pt.y != null);
      if (installmentPoints.length > 0 && !isCatalog) {
        datasets.push({
          label: `${label} (Parcelado)`,
          data: installmentPoints,
          borderColor: color,
          backgroundColor: 'transparent',
          borderWidth: 2,
          borderDash: [5, 5],
          pointBackgroundColor: '#fff',
          pointBorderColor: color,
          pointHoverRadius: 5,
          pointRadius: 3,
          tension: 0.15,
          showLine: true
        });
      }
    });

    if (datasets.length === 0) {
      showError('Sem Histórico', 'Este produto está cadastrado, mas ainda não possui dados históricos de preços.');
      return;
    }

    new Chart(ctx, {
      type: 'line',
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: {
            grid: { color: 'rgba(255, 255, 255, 0.05)' },
            ticks: { color: '#a0aec0', font: { size: 9 } }
          },
          y: {
            grid: { color: 'rgba(255, 255, 255, 0.05)' },
            ticks: {
              color: '#a0aec0',
              font: { size: 9 },
              callback: value => 'R$ ' + value
            }
          }
        },
        plugins: {
          legend: {
            position: 'top',
            labels: { color: '#a0aec0', font: { size: 9 }, boxWidth: 10, boxHeight: 10, padding: 8 }
          },
          tooltip: {
            callbacks: {
              label: context => {
                const label = context.dataset.label || '';
                const val = context.parsed.y;
                return `${label}: R$ ${val.toLocaleString('pt-BR')}`;
              }
            }
          }
        }
      }
    });
  }
})();
