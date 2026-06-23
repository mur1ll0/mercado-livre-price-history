// Global state variables
let token = localStorage.getItem('ml_token');
let user = null;
let productsData = [];
let priceChart = null;

const apiHost = window.location.origin;

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

// Attach logout event
document.getElementById('btn-logout').addEventListener('click', logout);

// 2. Fetch all products tracked by the user
async function loadDashboardData() {
  const container = document.getElementById('products-container');
  
  try {
    const res = await fetch(`${apiHost}/api/products/ranked`, {
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

// 3. Render statistics grid cards
function renderStats() {
  document.getElementById('stat-total-products').textContent = productsData.length;
  
  // Calculate average discount
  let totalDiscount = 0;
  let productsWithDiscount = 0;
  let bestOpportunityAnn = null;
  let bestScore = -1;

  productsData.forEach(prod => {
    if (prod.avgDiscount > 0) {
      totalDiscount += prod.avgDiscount;
      productsWithDiscount++;
    }
    // Find best overall announcement score
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
    
    // Sort announcements to get the best active deal
    const activeAnnouncements = (prod.announcements || []).filter(ann => !ann.isUnavailable);
    const bestDeal = activeAnnouncements.length > 0 ? activeAnnouncements[0] : null;
    
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
    const bestPriceFormatted = bestDeal && bestDeal.price !== null ? `R$ ${bestDeal.price.toLocaleString('pt-BR')}` : 'Indisponível';
    
    // Build mini-list of announcements
    let announcementsHtml = '';
    if (prod.announcements && prod.announcements.length > 0) {
      announcementsHtml = `
        <div class="product-announcements-list">
          <h4>Anúncios Vinculados (${prod.announcements.length})</h4>
          ${prod.announcements.slice(0, 3).map(ann => {
            const priceStr = ann.price !== null ? `R$ ${ann.price.toLocaleString('pt-BR')}` : 'Indisponível';
            const fullBadge = ann.isFull ? `<span class="mini-badge mb-full">Full</span>` : '';
            const freeBadge = ann.isFreeShipping ? `<span class="mini-badge mb-free">Grátis</span>` : '';
            const statusClass = ann.isUnavailable ? 'score-low-text' : 
                               (ann.costBenefitScore >= 80 ? 'score-high-text' : 
                               (ann.costBenefitScore >= 50 ? 'score-med-text' : 'score-low-text'));
            
            return `
              <div class="announcement-row">
                <span class="announcement-name" title="${ann.title}">${ann.title}</span>
                <span class="announcement-badges">${fullBadge}${freeBadge}</span>
                <span class="announcement-price">${priceStr}</span>
                <span class="announcement-score-badge ${statusClass}">${ann.isUnavailable ? 'Pausado' : ann.costBenefitScore + ' pts'}</span>
              </div>
            `;
          }).join('')}
          ${prod.announcements.length > 3 ? `<p style="font-size:0.75rem; color:var(--text-secondary); text-align:right; margin-top:0.2rem;">+ ${prod.announcements.length - 3} outros anúncios...</p>` : ''}
        </div>
      `;
    }

    const ratingRow = prod.rating !== null ? `
      <div class="product-rating-box">
        <svg class="star-icon" viewBox="0 0 20 20" width="14" height="14" fill="currentColor">
          <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
        </svg>
        <span class="rating-value">${prod.rating.toFixed(1)}</span>
        <span class="rating-count">(${prod.reviewsCount})</span>
      </div>
    ` : '<span style="font-size:0.75rem; color:var(--text-secondary);">Sem avaliações</span>';

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
          <div class="product-meta-top">
            <div>
              <h3 class="product-title">${prod.name}</h3>
              <p class="product-category">${prod.category}</p>
            </div>
            ${ratingRow}
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
      
      // Reload dashboard in 3 seconds to fetch details
      setTimeout(() => {
        loadDashboardData();
        succDiv.classList.add('hidden');
      }, 3000);
      
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
    const tr = document.createElement('tr');
    
    const priceStr = ann.price !== null ? `R$ ${ann.price.toLocaleString('pt-BR')}` : 'Pausado/Indisponível';
    
    // Shipping text
    let shippingInfo = '';
    if (ann.isFreeShipping) shippingInfo += 'Grátis ';
    if (ann.isFull) shippingInfo += '⚡Full ';
    if (ann.deliveryTime) {
      shippingInfo += `(${ann.deliveryTime.split(' por ser ')[0]})`; // Clean up first purchase promo
    }

    const badgeClass = ann.isUnavailable ? 'score-low-text' : 
                       (ann.costBenefitScore >= 80 ? 'score-high-text' : 
                       (ann.costBenefitScore >= 50 ? 'score-med-text' : 'score-low-text'));
    const scoreVal = ann.isUnavailable ? 'Pausado' : `${ann.costBenefitScore}/100`;

    tr.innerHTML = `
      <td class="tbl-deal-name" title="${ann.title}">${ann.title}</td>
      <td class="tbl-deal-price">${priceStr}</td>
      <td style="font-size:0.8rem;">${ann.installmentsText || '-'}</td>
      <td style="font-size:0.75rem; color:var(--text-secondary); max-width:180px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${shippingInfo || 'Frete a calcular'}</td>
      <td><span class="announcement-score-badge ${badgeClass}">${scoreVal}</span></td>
      <td>
        <a href="${ann.url}" target="_blank" class="ml-link-anchor">
          Ir ↗
        </a>
      </td>
    `;
    tbody.appendChild(tr);
  });

  // Render Chart
  renderChart(prod.announcements);

  // Configure update action inside modal
  const updateBtn = document.getElementById('modal-btn-update');
  const updateText = document.getElementById('modal-update-text');
  const updateIcon = document.getElementById('modal-update-icon');
  
  updateBtn.onclick = async () => {
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
      alert(resData.message || 'Sincronização agendada com sucesso!');
      
      // Delay to fetch reload
      setTimeout(() => {
        loadDashboardData().then(() => {
          modal.classList.add('hidden'); // Close modal to refresh details on click
        });
      }, 4000);
      
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

  // Pre-configured colors for multiple announcements
  const chartColors = [
    '#9f7aea', // Purple
    '#00f2fe', // Cyan/Teal
    '#10b981', // Green
    '#ed8936', // Orange
    '#e53e3e', // Red
    '#4299e1'  // Blue
  ];

  const datasets = [];

  announcements.forEach((ann, index) => {
    const history = ann.priceHistory || [];
    if (history.length === 0) return;

    // Map history to chart coordinates
    const dataPoints = history.map(h => ({
      x: h.date, // format YYYY-MM-DD
      y: h.price
    }));

    // Choose color
    const color = chartColors[index % chartColors.length];

    datasets.push({
      label: ann.title.substring(0, 20) + '...',
      data: dataPoints,
      borderColor: color,
      backgroundColor: color + '33', // transparency
      borderWidth: 2.5,
      pointBackgroundColor: color,
      pointBorderColor: '#fff',
      pointHoverRadius: 6,
      pointRadius: 4,
      tension: 0.15,
      showLine: true // Force lines joining scatter points
    });
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

    const data = await res.json();
    alert(data.message || 'Sincronização iniciada com sucesso!');
    
    setTimeout(() => {
      loadDashboardData();
    }, 5000);

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
loadDashboardData();
