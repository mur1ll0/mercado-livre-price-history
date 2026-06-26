// Global state variables
let token = localStorage.getItem('ml_token');
let user = null;
let productsData = [];
let priceChart = null;
let currentModalAnnouncements = [];
let extensionDetected = false;
let pollIntervalId = null;
let scrapeBannerTimeout = null;

const apiHost = window.location.origin;
const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

// 1. Session check on page load
function checkAuth() {
  if (!token) {
    window.location.href = '/login.html';
    return;
  }
  
  try {
    user = JSON.parse(localStorage.getItem('ml_user'));
    renderUserProfile();
  } catch (err) {
    logout();
  }
}

function renderUserProfile() {
  if (user) {
    document.getElementById('user-name').textContent = user.name || 'Usuário';
    document.getElementById('user-avatar').src = user.picture || 'https://www.gravatar.com/avatar/00000000000000000000000000000000?d=mp&f=y';
  }
}

function logout() {
  localStorage.removeItem('ml_token');
  localStorage.removeItem('ml_user');
  window.location.href = '/login.html';
}

// Detect if browser extension is installed
function detectExtension() {
  // 1. Direct DOM check (set by content script at document_start)
  if (document.documentElement && document.documentElement.dataset.mlPriceTrackerInstalled === "true") {
    extensionDetected = true;
    handleExtensionState(true, true);
    return;
  }

  // 2. Runtime messaging fallback
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
    try {
      chrome.runtime.sendMessage('dummy-id-placeholder', { type: 'PING' }, function() {});
    } catch (e) {}
  }
  
  // 3. postMessage ping fallback
  window.postMessage({ type: 'ML_TRACKER_PING', source: 'ml-price-tracker-web' }, '*');
}

// Function to dynamically toggle action buttons based on extension status
function handleExtensionState(detected, shouldConfigure = true) {
  const syncBtn = document.getElementById('btn-sync-all');
  const installBtn = document.getElementById('btn-install-extension');
  
  if (detected) {
    if (syncBtn) syncBtn.classList.remove('hidden');
    if (installBtn) installBtn.classList.add('hidden');
    
    // Auto configure token inside the extension
    if (token && shouldConfigure) {
      window.postMessage({
        type: 'ML_CONFIGURE_EXTENSION',
        source: 'ml-price-tracker-web',
        apiBase: window.location.origin,
        jwtToken: token
      }, '*');
    }
  } else {
    if (syncBtn) syncBtn.classList.add('hidden');
    if (installBtn) installBtn.classList.remove('hidden');
  }
}

// Browser detection helper
function getBrowserType() {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('firefox')) return 'firefox';
  return 'chrome'; // Default fallback
}

// Single consolidated message event listener (replaces duplicate listeners)
window.addEventListener('message', function(event) {
  if (!event.data || event.data.source !== 'ml-price-tracker-extension') return;

  if (event.data.type === 'ML_TRACKER_PONG') {
    extensionDetected = true;
    handleExtensionState(true, true);
  }
  if (event.data.type === 'ML_TRACKER_CONFIGURED') {
    extensionDetected = true;
    handleExtensionState(true, false);
  }
});

// Immediately try detection
detectExtension();
setTimeout(function() {
  // Re-check DOM attribute just in case the content script finished injecting slightly late
  if (document.documentElement && document.documentElement.dataset.mlPriceTrackerInstalled === "true") {
    extensionDetected = true;
    handleExtensionState(true, true);
  }
  if (!extensionDetected) {
    handleExtensionState(false);
  }
}, 1500);

// Scrape Status Polling
function startStatusPolling() {
  if (pollIntervalId) stopStatusPolling();
  pollIntervalId = setInterval(pollScrapeStatus, 2000);
  pollScrapeStatus(); // immediate first check
}

function stopStatusPolling() {
  if (pollIntervalId) {
    clearInterval(pollIntervalId);
    pollIntervalId = null;
  }
}

async function pollScrapeStatus() {
  try {
    const res = await fetch(`${apiHost}/api/scrape/status`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) return;
    const status = await res.json();

    if (status.state === 'idle') {
      hideScrapeBanner();
      stopStatusPolling();
      return;
    }

    showScrapeBanner(status.state, status.message);

    if (status.state === 'done' || status.state === 'error') {
      stopStatusPolling();
      hideScrapeBanner();
      setTimeout(function() { loadDashboardData(); }, 500);
    }
  } catch (e) {
    // ignore polling errors
  }
}

function showScrapeBanner(state, message) {
  const banner = document.getElementById('scrape-status-banner');
  if (!banner) return;
  banner.className = `scrape-status-banner ${state}`;
  banner.classList.remove('hidden');

  const icon = document.getElementById('scrape-status-icon');
  const msg = document.getElementById('scrape-status-message');

  if (icon) {
    if (state === 'running') {
      icon.innerHTML = '<span class="scrape-status-icon-spin"></span>';
    } else if (state === 'done') {
      icon.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
    } else if (state === 'error') {
      icon.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>';
    } else if (state === 'needs_login') {
      icon.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z"/></svg>';
    }
  }
  if (msg) msg.textContent = message;
}

function hideScrapeBanner() {
  const banner = document.getElementById('scrape-status-banner');
  if (banner) banner.classList.add('hidden');
  if (scrapeBannerTimeout) { clearTimeout(scrapeBannerTimeout); scrapeBannerTimeout = null; }
}

// Extension Installation Modal
function showExtensionModal() {
  const modal = document.getElementById('extension-modal');
  if (modal) modal.classList.remove('hidden');
}

function hideExtensionModal() {
  const modal = document.getElementById('extension-modal');
  if (modal) modal.classList.add('hidden');
}

// Local instructions toggle
document.addEventListener('DOMContentLoaded', function() {
  var localLink = document.getElementById('local-instructions-link');
  var localBox = document.getElementById('local-instructions-box');
  if (localLink && localBox) {
    localLink.addEventListener('click', function(e) {
      e.preventDefault();
      localBox.classList.toggle('hidden');
    });
  }

  var closeExtBtn = document.getElementById('close-extension-modal-btn');
  if (closeExtBtn) {
    closeExtBtn.addEventListener('click', hideExtensionModal);
  }

  var extModal = document.getElementById('extension-modal');
  if (extModal) {
    extModal.addEventListener('click', function(e) {
      if (e.target.id === 'extension-modal') hideExtensionModal();
    });
  }

  const installBtn = document.getElementById('btn-install-extension');
  if (installBtn) {
    installBtn.addEventListener('click', function(e) {
      e.preventDefault();
      const browser = getBrowserType();
      const modal = document.getElementById('extension-modal');
      const chromeInst = document.getElementById('instructions-chrome');
      const firefoxInst = document.getElementById('instructions-firefox');
      const dlBtn = document.getElementById('dl-extension-btn');
      
      if (browser === 'firefox') {
        if (chromeInst) chromeInst.classList.add('hidden');
        if (firefoxInst) firefoxInst.classList.remove('hidden');
        if (dlBtn) {
          dlBtn.href = '/extensions/firefox.zip';
          dlBtn.textContent = 'Baixar Extensão para Firefox (.zip)';
        }
      } else {
        if (chromeInst) chromeInst.classList.remove('hidden');
        if (firefoxInst) firefoxInst.classList.add('hidden');
        if (dlBtn) {
          dlBtn.href = '/extensions/chrome.zip';
          dlBtn.textContent = 'Baixar Extensão para Chrome / Edge (.zip)';
        }
      }
      
      if (modal) modal.classList.remove('hidden');
    });
  }
});

// Attach logout event
document.getElementById('btn-logout').addEventListener('click', logout);

// 2. Fetch all products tracked by the user
async function loadDashboardData() {
  const container = document.getElementById('products-container');
  const categoryFilter = document.getElementById('filter-category') ? document.getElementById('filter-category').value : '';
  
  try {
    let url = `${apiHost}/api/products/ranked`;
    if (categoryFilter) {
      url += `?category=${encodeURIComponent(categoryFilter)}`;
    }
    
    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    
    if (res.status === 401 || res.status === 403) {
      logout();
      return;
    }
    
    const data = await res.json();
    productsData = data;
    
    renderStats();
    renderProductsList();
    
  } catch (err) {
    console.error('Error fetching dashboard products:', err);
    container.innerHTML = `
      <div class="error-state">
        <p>Ocorreu um erro ao carregar os dados. Recarregue a página.</p>
      </div>
    `;
  }
}

// 2.5. Load all composite category nodes for the dropdown filter
async function loadCategories() {
  const dropdown = document.getElementById('filter-category');
  if (!dropdown) return;

  try {
    const res = await fetch(`${apiHost}/api/categories`, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (!res.ok) throw new Error('Falha ao carregar categorias');

    const categories = await res.json();
    
    dropdown.innerHTML = '<option value="">Todas as Categorias</option>';
    
    categories.forEach(cat => {
      const option = document.createElement('option');
      option.value = cat._id;
      
      const indent = '&nbsp;&nbsp;'.repeat(cat.level);
      const prefix = cat.level > 0 ? '↳ ' : '';
      option.innerHTML = `${indent}${prefix}${cat.name}`;
      dropdown.appendChild(option);
    });
  } catch (err) {
    console.error('Error loading category tree:', err);
  }
}

// 3. Render statistics grid cards
function renderStats() {
  document.getElementById('stat-total-products').textContent = productsData.length;
  
  let totalDiscount = 0;
  let productsWithDiscount = 0;
  let bestOpportunityAnn = null;
  let bestScore = -1;

  productsData.forEach(prod => {
    if (prod.avgDiscount > 0) {
      totalDiscount += prod.avgDiscount;
      productsWithDiscount++;
    }
    (prod.announcements || []).forEach(ann => {
      if (!ann.isUnavailable && ann.costBenefitScore > bestScore) {
        bestScore = ann.costBenefitScore;
        bestOpportunityAnn = ann;
      }
    });
  });

  const avgDisc = productsWithDiscount > 0 ? (totalDiscount / productsWithDiscount).toFixed(1) : 0;
  document.getElementById('stat-avg-discount').textContent = `${avgDisc}%`;

  const bestDealEl = document.getElementById('stat-best-deal');
  if (bestOpportunityAnn) {
    bestDealEl.textContent = `${bestOpportunityAnn.title} (${bestOpportunityAnn.costBenefitScore} pts)`;
    bestDealEl.title = bestOpportunityAnn.title;
  } else {
    bestDealEl.textContent = '-';
  }
}

function getAnnouncementPrice(ann) {
  if (ann.type === 'catalog' && ann.offers) {
    return ann.offers.BEST_PRICE?.price || ann.offers.BEST_INSTALLMENTS?.price || null;
  }
  return ann.price;
}

function getAnnouncementSeller(ann) {
  if (ann.type === 'catalog' && ann.offers) {
    return ann.offers.BEST_PRICE?.seller || ann.offers.BEST_INSTALLMENTS?.seller || null;
  }
  return ann.seller;
}

function getAnnouncementInstallments(ann) {
  if (ann.type === 'catalog' && ann.offers) {
    return ann.offers.BEST_INSTALLMENTS?.installmentsText || ann.offers.BEST_PRICE?.installmentsText || '-';
  }
  return ann.installmentsText || '-';
}

function formatShipping(ann) {
  var isFree, isFull, deliveryDate, shippingCost;
  if (ann.type === 'catalog' && ann.offers) {
    var bp = ann.offers.BEST_PRICE || {};
    isFree = bp.isFreeShipping;
    isFull = bp.isFull;
    deliveryDate = bp.deliveryDate || null;
    shippingCost = bp.shippingCost;
  } else {
    isFree = ann.isFreeShipping;
    isFull = ann.isFull;
    deliveryDate = ann.deliveryDate || null;
    shippingCost = ann.shippingCost;
  }

  var parts = [];

  if (isFull) parts.push('⚡Full');
  if (isFree && !isFull) parts.push('Grátis');

  if (deliveryDate) {
    var delDate = new Date(deliveryDate);
    delDate.setHours(0,0,0,0);
    var today = new Date();
    today.setHours(0,0,0,0);
    var diffDays = Math.ceil((delDate - today) / (1000 * 60 * 60 * 24));
    var weekdays = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
    var day = delDate.getDate();
    var months = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
    var month = months[delDate.getMonth()];
    var weekday = weekdays[delDate.getDay()];

    var daysStr = '';
    if (diffDays <= 0) daysStr = 'hoje';
    else if (diffDays === 1) daysStr = 'amanhã';
    else daysStr = 'até ' + diffDays + ' dias';

    var costStr = isFree ? 'Grátis' : '';
    if (!isFree && shippingCost != null) {
      costStr = 'por R$' + shippingCost.toFixed(2).replace('.', ',');
    }
    parts.push(costStr + ' ' + daysStr + ' (' + day + '/' + month + ' ' + weekday + ')'.trim());
  } else {
    parts.push('Consulte prazos no link');
  }

  return {
    displayText: parts.join(' ') || 'Consulte prazos no link',
    isFree: isFree,
    isFull: isFull,
    deliveryDate: deliveryDate,
    shippingCost: shippingCost
  };
}

function getAnnouncementShipping(ann) {
  var ship = formatShipping(ann);
  return { isFree: ship.isFree, isFull: ship.isFull, deliveryDate: ship.deliveryDate };
}

function getBestDeal(announcements) {
  const active = (announcements || []).filter(a => !a.isUnavailable);
  if (active.length === 0) return null;
  return active.reduce((best, a) => (a.costBenefitScore > best.costBenefitScore ? a : best), active[0]);
}

// 4. Render product cards
function renderProductsList() {
  const container = document.getElementById('products-container');
  
  if (productsData.length === 0) {
    container.innerHTML = `
      <div class="glass-panel text-center" style="padding: 3rem; color: var(--text-secondary);">
        <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5" style="margin-bottom: 1rem; opacity: 0.5;">
          <circle cx="12" cy="12" r="10" />
          <line x1="8" y1="12" x2="16" y2="12" />
        </svg>
        <p style="font-weight: 500;">Nenhum produto cadastrado ainda.</p>
        <p style="font-size: 0.8rem; margin-top: 0.3rem;">Insira um link do Mercado Livre acima para começar o monitoramento.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = '';

  productsData.forEach(prod => {
    const card = document.createElement('div');
    const announcements = prod.announcements || [];
    const bestDeal = getBestDeal(announcements);
    
    let scoreClass = 'score-low';
    let scoreText = 'Regular';
    
    if (bestDeal) {
      if (bestDeal.costBenefitScore >= 80) {
        scoreClass = 'score-high';
        scoreText = 'Excelente Custo-Benefício';
      } else if (bestDeal.costBenefitScore >= 50) {
        scoreClass = 'score-med';
        scoreText = 'Bom Custo-Benefício';
      }
    }

    card.className = `product-card ${scoreClass}`;
    
    const imageSrc = prod.image || 'https://http2.mlstatic.com/frontend-assets/ml-web-navigation/img/social/ML_logo.png';
    const bestPrice = bestDeal ? getAnnouncementPrice(bestDeal) : null;
    const bestPriceFormatted = bestPrice !== null ? `R$ ${bestPrice.toLocaleString('pt-BR')}` : 'Indisponível';
    
    // Build mini-list of announcements
    let announcementsHtml = '';
    if (announcements.length > 0) {
      announcementsHtml = `
        <div class="product-announcements-list">
          <h4>Anúncios Vinculados (${announcements.length})</h4>
          ${announcements.slice(0, 3).map(ann => {
            const annPrice = getAnnouncementPrice(ann);
            const priceStr = annPrice !== null ? `R$ ${annPrice.toLocaleString('pt-BR')}` : 'Indisponível';
            const ship = formatShipping(ann);
            const seller = getAnnouncementSeller(ann);
            const sellerStr = seller ? `<span class="ann-seller">${seller}</span>` : '';
            const statusClass = ann.isUnavailable ? 'score-low-text' : 
                               (ann.costBenefitScore >= 80 ? 'score-high-text' : 
                               (ann.costBenefitScore >= 50 ? 'score-med-text' : 'score-low-text'));
            
            return `
              <div class="announcement-row">
                <div class="announcement-info-left">
                  <span class="announcement-name" title="${ann.title}">${ann.title}</span>
                  <div class="ann-meta-row">${sellerStr}<span class="ann-ship-info">${ship.displayText}</span></div>
                </div>
                <div class="announcement-info-right">
                  <span class="announcement-price">${priceStr}</span>
                  <span class="announcement-score-badge ${statusClass}">${ann.isUnavailable ? 'Pausado' : ann.costBenefitScore + ' pts'}</span>
                </div>
              </div>
            `;
          }).join('')}
          ${announcements.length > 3 ? `<p style="font-size:0.75rem; color:var(--text-secondary); text-align:right; margin-top:0.2rem;">+ ${announcements.length - 3} outros anúncios...</p>` : ''}
        </div>
      `;
    }

    const ratingRow = prod.rating !== null ? `
      <div class="product-rating-box">
        <svg class="star-icon" viewBox="0 0 20 20" width="12" height="12" fill="currentColor">
          <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
        </svg>
        <span class="rating-value">${prod.rating.toFixed(1)}</span>
        <span class="rating-count">(${prod.reviewsCount} opiniões)</span>
      </div>
    ` : '<span style="font-size:0.72rem; color:var(--text-secondary);">Sem avaliações</span>';

    card.innerHTML = `
      <button class="btn-delete-product" data-id="${prod._id}" title="Parar de monitorar este produto">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="3 6 5 6 21 6" />
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        </svg>
      </button>
      
      <div class="product-img-col" onclick="openDetailsModal('${prod._id}')">
        <img src="${imageSrc}" alt="${prod.name}">
      </div>
      
      <div class="product-content-col" onclick="openDetailsModal('${prod._id}')">
        <div>
          <h3 class="product-title" title="${prod.name}">${prod.name}</h3>
          <div class="product-meta-row">
            <span class="product-category">${prod.categories?.[prod.categories.length - 1]?.split(' > ').pop() || 'Geral'}</span>
            ${ratingRow}
          </div>
          
          <div class="product-price-info">
            <div class="price-badge-container">
              <span class="price-tag">${bestPriceFormatted}</span>
              ${bestDeal && bestDeal.discountPercent > 0 ? `<span class="discount-pill">-${bestDeal.discountPercent}%</span>` : ''}
            </div>
          </div>
          
          ${announcementsHtml}
        </div>
      </div>
    `;

    container.appendChild(card);
  });

  // Attach delete listeners
  document.querySelectorAll('.btn-delete-product').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const productId = btn.getAttribute('data-id');
      if (confirm('Deseja realmente parar de rastrear este produto e todos os seus anúncios vinculados?')) {
        deleteProduct(productId);
      }
    });
  });
}

// 5. Untrack a unified product
async function deleteProduct(productId) {
  try {
    const res = await fetch(`${apiHost}/api/products/track/${productId}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    const data = await res.json();
    if (res.ok) {
      loadDashboardData();
    } else {
      alert(data.error || 'Erro ao deletar produto.');
    }
  } catch (err) {
    console.error('Delete product failed:', err);
  }
}

// 6. Submit form to track new URL
document.getElementById('add-product-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const urlInput = document.getElementById('product-url');
  const btnSubmit = document.getElementById('btn-submit');
  const btnText = btnSubmit.querySelector('.btn-text');
  const spinner = btnSubmit.querySelector('.btn-spinner');
  
  const errDiv = document.getElementById('form-error');
  const succDiv = document.getElementById('form-success');
  
  errDiv.classList.add('hidden');
  succDiv.classList.add('hidden');
  
  const url = urlInput.value.trim();
  if (!url) return;

  // Toggle Loading
  btnSubmit.disabled = true;
  btnText.textContent = 'Enviando...';
  spinner.classList.remove('hidden');

  try {
    const res = await fetch(`${apiHost}/api/products/track`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ url })
    });

    const data = await res.json();

    if (res.status === 200 || res.status === 201 || res.status === 202) {
      succDiv.textContent = data.message || 'Produto adicionado com sucesso! Carregando dados...';
      succDiv.classList.remove('hidden');
      urlInput.value = '';
      startStatusPolling();
      setTimeout(() => succDiv.classList.add('hidden'), 3000);
      
    } else {
      errDiv.textContent = data.error || 'Ocorreu um erro ao processar o link.';
      errDiv.classList.remove('hidden');
    }

  } catch (err) {
    errDiv.textContent = 'Erro de conexão com o servidor.';
    errDiv.classList.remove('hidden');
    console.error(err);
  } finally {
    btnSubmit.disabled = false;
    btnText.textContent = 'Adicionar Produto';
    spinner.classList.add('hidden');
  }
});

// 7. Modal detail management
function openDetailsModal(productId) {
  const prod = productsData.find(p => p.id === productId);
  if (!prod) return;

  currentModalAnnouncements = prod.announcements || [];
  const chartPriceTypeSelector = document.getElementById('chart-price-type');
  if (chartPriceTypeSelector) {
    chartPriceTypeSelector.value = 'cash'; // Reset to cash price by default
  }

  const modal = document.getElementById('details-modal');
  
  // Fill details
  document.getElementById('modal-title').textContent = prod.name;
  document.getElementById('modal-category').textContent = prod.category;
  
  const mainImg = prod.image || 'https://http2.mlstatic.com/frontend-assets/ml-web-navigation/img/social/ML_logo.png';
  document.getElementById('modal-image').src = mainImg;

  // Ratings
  const ratingsRow = document.getElementById('modal-rating-row');
  if (prod.rating !== null) {
    ratingsRow.innerHTML = `
      <div class="product-rating-box" style="display:inline-flex;">
        <svg class="star-icon" viewBox="0 0 20 20" width="14" height="14" fill="currentColor">
          <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
        </svg>
        <span class="rating-value">${prod.rating.toFixed(1)}</span>
        <span class="rating-count">(${prod.reviewsCount} opiniões)</span>
      </div>
    `;
  } else {
    ratingsRow.innerHTML = '<span style="font-size:0.85rem; color:var(--text-secondary);">Sem avaliações</span>';
  }

  // AI Summary Opinion
  const aiSection = document.getElementById('modal-ai-summary-section');
  const aiText = document.getElementById('modal-ai-summary');
  
  if (prod.aiSummary && prod.aiSummary.trim()) {
    aiText.textContent = prod.aiSummary;
    aiSection.classList.remove('hidden');
  } else {
    aiSection.classList.add('hidden');
  }

  // Fill Comparison Table
  const tbody = document.getElementById('modal-comparison-tbody');
  tbody.innerHTML = '';

  prod.announcements.forEach(ann => {
    const seller = getAnnouncementSeller(ann) || '-';
    const statusClass = ann.isUnavailable ? 'score-low-text' : 
                       (ann.costBenefitScore >= 80 ? 'score-high-text' : 
                       (ann.costBenefitScore >= 50 ? 'score-med-text' : 'score-low-text'));
    const scoreVal = ann.isUnavailable ? 'Pausado' : `${ann.costBenefitScore}/100`;
    const annUrl = ann.url || '';

    const tr = document.createElement('tr');

    if (ann.type === 'catalog' && ann.offers) {
      var bp = ann.offers.BEST_PRICE;
      var bi = ann.offers.BEST_INSTALLMENTS;
      var bpPrice = bp && bp.price ? 'R$ ' + bp.price.toLocaleString('pt-BR') : '-';
      var bpShip = bp ? formatShipping({ type: 'catalog', offers: { BEST_PRICE: bp } }) : { displayText: '-' };
      var installmentsStr = bi && bi.installmentsText ? bi.installmentsText : '-';
      var biShip = bi ? formatShipping({ type: 'catalog', offers: { BEST_PRICE: bi } }) : null;

      tr.innerHTML = `
        <td class="tbl-deal-name" title="${ann.title}">
          <a href="${annUrl}" target="_blank" class="ml-link-anchor">${ann.title}</a>
        </td>
        <td class="tbl-deal-price">${bpPrice}</td>
        <td style="font-size:0.8rem;">${seller}</td>
        <td style="font-size:0.8rem;">${installmentsStr}</td>
        <td style="font-size:0.75rem; color:var(--text-secondary); max-width:250px;">${bpShip.displayText}</td>
        <td><span class="announcement-score-badge ${statusClass}">${scoreVal}</span></td>
      `;
    } else {
      const annPrice = getAnnouncementPrice(ann);
      const annInstallments = getAnnouncementInstallments(ann);
      const priceStr = annPrice !== null ? `R$ ${annPrice.toLocaleString('pt-BR')}` : 'Indisponível';
      const ship = formatShipping(ann);

      tr.innerHTML = `
        <td class="tbl-deal-name" title="${ann.title}">
          <a href="${annUrl}" target="_blank" class="ml-link-anchor">${ann.title}</a>
        </td>
        <td class="tbl-deal-price">${priceStr}</td>
        <td style="font-size:0.8rem;">${seller}</td>
        <td style="font-size:0.8rem;">${annInstallments}</td>
        <td style="font-size:0.75rem; color:var(--text-secondary); max-width:250px;">${ship.displayText}</td>
        <td><span class="announcement-score-badge ${statusClass}">${scoreVal}</span></td>
      `;
    }
    tbody.appendChild(tr);
  });

  // Render Chart
  renderChart(prod.announcements);

  // Configure update action inside modal
  const updateBtn = document.getElementById('modal-btn-update');
  const updateText = document.getElementById('modal-update-text');
  const updateIcon = document.getElementById('modal-update-icon');
  
  updateBtn.onclick = async () => {
    if (!isLocalhost && !extensionDetected) {
      showExtensionModal();
      return;
    }

    updateBtn.disabled = true;
    updateText.textContent = 'Enviando comando...';
    updateIcon.classList.add('active');
    
    try {
      const res = await fetch(`${apiHost}/api/products/scrape/${prod.id}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      
      const resData = await res.json();

      // Trigger immediate local extension sync
      window.postMessage({ type: 'ML_TRIGGER_SCRAPE_NOW', source: 'ml-price-tracker-web' }, '*');
      
      if (isLocalhost) {
        alert(resData.message || 'Sincronização agendada com sucesso!');
      } else {
        startStatusPolling();
      }
      
      setTimeout(() => {
        loadDashboardData().then(() => {
          modal.classList.add('hidden');
        });
      }, isLocalhost ? 4000 : 15000);
      
    } catch (err) {
      console.error(err);
      alert('Falha ao solicitar atualização.');
    } finally {
      updateBtn.disabled = false;
      updateText.textContent = 'Atualizar Todos Anúncios';
      updateIcon.classList.remove('active');
    }
  };

  modal.classList.remove('hidden');
}

// 8. Render Scatter Plot Chart using Chart.js
function renderChart(announcements) {
  const ctx = document.getElementById('priceHistoryChart').getContext('2d');
  
  if (priceChart) {
    priceChart.destroy();
  }

  const chartColors = [
    '#9f7aea', // Purple
    '#00f2fe', // Cyan/Teal
    '#10b981', // Green
    '#ed8936', // Orange
    '#e53e3e', // Red
    '#4299e1'  // Blue
  ];

  const datasets = [];
  const priceType = document.getElementById('chart-price-type') ? document.getElementById('chart-price-type').value : 'cash';

  announcements.forEach((ann, index) => {
    const history = ann.priceHistory || [];
    if (history.length === 0) return;

    const color = chartColors[index % chartColors.length];
    const shortTitle = ann.title ? ann.title.substring(0, 20) + '...' : 'Anúncio';

    // Separate history by offerKey for catalog announcements
    const cashHistory = history.filter(h => !h.offerKey || h.offerKey === 'BEST_PRICE');
    const installmentHistory = history.filter(h => h.offerKey === 'BEST_INSTALLMENTS' && h.installmentsTotal != null);

    // 1. Add Cash/Vista Price dataset
    if ((priceType === 'cash' || priceType === 'both') && cashHistory.length > 0) {
      const dataPoints = cashHistory.map(h => ({
        x: h.date,
        y: h.price
      }));
      datasets.push({
        label: `${shortTitle} (à Vista)`,
        data: dataPoints,
        borderColor: color,
        backgroundColor: color + '22',
        borderWidth: 2.5,
        pointBackgroundColor: color,
        pointBorderColor: '#fff',
        pointHoverRadius: 6,
        pointRadius: 4,
        tension: 0.15,
        showLine: true
      });
    }

    // 2. Add Installments Total dataset
    if ((priceType === 'installments' || priceType === 'both') && installmentHistory.length > 0) {
      const dataPoints = installmentHistory.map(h => ({
        x: h.date,
        y: h.installmentsTotal || h.price
      }));
      datasets.push({
        label: `${shortTitle} (Parcelado)`,
        data: dataPoints,
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

    // For normal announcements (no offerKey), fallback to old behavior
    if (installmentHistory.length === 0 && (priceType === 'installments' || priceType === 'both')) {
      const normalHistory = history.filter(h => !h.offerKey && h.installmentsTotal != null);
      if (normalHistory.length > 0) {
        const dataPoints = normalHistory.map(h => ({
          x: h.date,
          y: h.installmentsTotal || h.price
        }));
        datasets.push({
          label: `${shortTitle} (Parcelado)`,
          data: dataPoints,
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
    }
  });

  priceChart = new Chart(ctx, {
    type: 'line',
    data: {
      datasets: datasets
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          grid: {
            color: 'rgba(255, 255, 255, 0.05)'
          },
          ticks: {
            color: '#a0aec0',
            font: {
              size: 10
            }
          }
        },
        y: {
          grid: {
            color: 'rgba(255, 255, 255, 0.05)'
          },
          ticks: {
            color: '#a0aec0',
            font: {
              size: 10
            },
            callback: function(value) {
              return 'R$ ' + value;
            }
          }
        }
      },
      plugins: {
        legend: {
          position: 'top',
          labels: {
            color: '#a0aec0',
            font: {
              size: 10
            },
            boxPadding: 4
          }
        },
        tooltip: {
          callbacks: {
            label: function(context) {
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

// Close modal handlers
document.getElementById('close-modal-btn').addEventListener('click', () => {
  document.getElementById('details-modal').classList.add('hidden');
});

// Close when clicking overlay background
document.getElementById('details-modal').addEventListener('click', (e) => {
  if (e.target.id === 'details-modal') {
    document.getElementById('details-modal').classList.add('hidden');
  }
});

// 9. Sync All trigger button
document.getElementById('btn-sync-all').addEventListener('click', async () => {
  if (!isLocalhost && !extensionDetected) {
    showExtensionModal();
    return;
  }

  const syncBtn = document.getElementById('btn-sync-all');
  const syncText = document.getElementById('sync-text');
  const syncIcon = document.getElementById('sync-icon');

  syncBtn.disabled = true;
  syncText.textContent = 'Atualizando...';
  syncIcon.classList.add('active');

  try {
    const res = await fetch(`${apiHost}/api/products/scrape`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    await res.json();

    // Trigger immediate local extension sync
    window.postMessage({ type: 'ML_TRIGGER_SCRAPE_NOW', source: 'ml-price-tracker-web' }, '*');

    startStatusPolling();

    setTimeout(() => {
      loadDashboardData();
    }, 15000);

  } catch (err) {
    console.error(err);
    alert('Erro de conexão ao tentar atualizar preços.');
  } finally {
    syncBtn.disabled = false;
    syncText.textContent = 'Atualizar Preços';
    syncIcon.classList.remove('active');
  }
});

// Initial startup
checkAuth();

if (token) {
  loadCategories();
}

// Category filter event listener
const filterCategoryEl = document.getElementById('filter-category');
if (filterCategoryEl) {
  filterCategoryEl.addEventListener('change', () => {
    loadDashboardData();
  });
}

loadDashboardData();

if (!isLocalhost) {
  startStatusPolling();
}

// Chart price type filter listener
const chartPriceTypeEl = document.getElementById('chart-price-type');
if (chartPriceTypeEl) {
  chartPriceTypeEl.addEventListener('change', () => {
    if (currentModalAnnouncements && currentModalAnnouncements.length > 0) {
      renderChart(currentModalAnnouncements);
    }
  });
}
