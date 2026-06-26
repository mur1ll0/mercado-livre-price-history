(function() {
  // Read configured API Base URL from storage
  chrome.storage.local.get(['apiBase'], function(stored) {
    const apiBase = stored.apiBase;
    if (!apiBase) {
      console.log('[ML Tracker Widget] Extension not connected to server yet. Widget disabled.');
      return;
    }

    // Initialize widget injection
    initWidget(apiBase);
  });

  function initWidget(apiBase) {
    // Avoid double injection
    if (document.getElementById('ml-tracker-price-widget-btn')) return;

    // Locate product page elements where we can insert our button
    // Insertion priority: 1. Under title, 2. Near price, 3. Fallback to buybox
    const targetElement = document.querySelector('.ui-pdp-title') || 
                          document.querySelector('.ui-pdp-header__price-container') ||
                          document.querySelector('.ui-pdp-buybox');

    if (!targetElement) {
      console.log('[ML Tracker Widget] Target insertion element not found on page.');
      return;
    }

    // Create the widget button
    const btn = document.createElement('button');
    btn.id = 'ml-tracker-price-widget-btn';
    btn.className = 'ml-tracker-widget-btn';
    btn.type = 'button';
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" style="margin-right: 6px; vertical-align: middle;">
        <line x1="18" y1="20" x2="18" y2="10"></line>
        <line x1="12" y1="20" x2="12" y2="4"></line>
        <line x1="6" y1="20" x2="6" y2="14"></line>
      </svg>
      Ver Histórico de Preços
    `;

    // Inject styles
    const styles = document.createElement('style');
    styles.textContent = `
      .ml-tracker-widget-btn {
        display: inline-flex;
        align-items: center;
        background: linear-gradient(135deg, #7c3aed, #4f46e5);
        color: #ffffff;
        border: none;
        padding: 6px 12px;
        border-radius: 6px;
        font-family: system-ui, -apple-system, sans-serif;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
        margin: 10px 0;
        box-shadow: 0 2px 8px rgba(124, 58, 237, 0.25);
        transition: transform 0.2s, box-shadow 0.2s, background 0.2s;
        outline: none;
      }
      .ml-tracker-widget-btn:hover {
        background: linear-gradient(135deg, #8b5cf6, #6366f1);
        transform: translateY(-1px);
        box-shadow: 0 4px 12px rgba(124, 58, 237, 0.4);
      }
      .ml-tracker-widget-btn:active {
        transform: translateY(0);
        box-shadow: 0 2px 4px rgba(124, 58, 237, 0.2);
      }
      
      .ml-tracker-overlay {
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(10, 7, 18, 0.5);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        z-index: 1000000;
        display: flex;
        align-items: center;
        justify-content: center;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.3s ease;
      }
      .ml-tracker-overlay.active {
        opacity: 1;
        pointer-events: auto;
      }
      
      .ml-tracker-modal {
        background: #110e24;
        width: 90%;
        max-width: 680px;
        height: 480px;
        border-radius: 16px;
        border: 1px solid rgba(255, 255, 255, 0.08);
        box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 10px 10px -5px rgba(0, 0, 0, 0.4);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        transform: scale(0.95);
        transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
      }
      .ml-tracker-overlay.active .ml-tracker-modal {
        transform: scale(1);
      }
      
      .ml-tracker-modal-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 14px 20px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.06);
      }
      .ml-tracker-modal-header h3 {
        color: #ffffff;
        margin: 0;
        font-family: system-ui, sans-serif;
        font-size: 14px;
        font-weight: 600;
      }
      
      .ml-tracker-modal-close {
        background: none;
        border: none;
        color: #a0aec0;
        font-size: 20px;
        cursor: pointer;
        outline: none;
        padding: 4px;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: color 0.2s;
      }
      .ml-tracker-modal-close:hover {
        color: #ffffff;
      }
      
      .ml-tracker-modal iframe {
        flex: 1;
        border: none;
        background: #0a0712;
        width: 100%;
        height: 100%;
      }
    `;
    document.head.appendChild(styles);

    // Inject the button after the target element
    targetElement.parentNode.insertBefore(btn, targetElement.nextSibling);

    // Create Modal Overlay
    const overlay = document.createElement('div');
    overlay.className = 'ml-tracker-overlay';
    overlay.innerHTML = `
      <div class="ml-tracker-modal">
        <div class="ml-tracker-modal-header">
          <h3>Histórico de Preços - Price History Tracker</h3>
          <button class="ml-tracker-modal-close" type="button">&times;</button>
        </div>
        <iframe src="" id="ml-tracker-widget-frame"></iframe>
      </div>
    `;
    document.body.appendChild(overlay);

    const iframe = overlay.querySelector('#ml-tracker-widget-frame');
    const closeBtn = overlay.querySelector('.ml-tracker-modal-close');

    // Click handler for opening widget modal
    btn.addEventListener('click', function(e) {
      e.preventDefault();
      const currentUrl = window.location.href;
      iframe.src = `${apiBase}/price-widget.html?url=${encodeURIComponent(currentUrl)}`;
      overlay.classList.add('active');
    });

    // Close handler
    const closeModal = () => {
      overlay.classList.remove('active');
      setTimeout(() => { iframe.src = ''; }, 300); // clear source on close
    };

    closeBtn.addEventListener('click', closeModal);
    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) closeModal();
    });
  }
})();
