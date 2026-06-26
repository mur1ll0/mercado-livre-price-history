(function() {
  const host = window.location.hostname;
  const port = window.location.port;
  const isLocalhost = host === 'localhost' || host === '127.0.0.1';
  const isVercel = host === 'mercado-livre-price-history.vercel.app';

  // Only inject/run on our target app pages (port 3000 locally, or Vercel production)
  // This allows us to use portless wildcards in manifest.json for maximum cross-browser compatibility (e.g. Firefox MV2, Safari, Opera)
  if (!isVercel && !(isLocalhost && port === '3000')) {
    return;
  }

  var browserAPI = typeof browser !== 'undefined' ? browser : chrome;
  var apiBase = window.location.origin;

  console.log('[ML Tracker CS] Injected into target origin:', apiBase);

  // Set high-performance detection attribute on the document element for instant recognition
  function setInstalledAttribute() {
    if (document.documentElement) {
      document.documentElement.dataset.mlPriceTrackerInstalled = "true";
      return true;
    }
    return false;
  }

  // Try setting immediately
  if (!setInstalledAttribute()) {
    // If not ready yet (e.g. document_start early phase), watch for its creation using MutationObserver
    var observer = new MutationObserver(function() {
      if (setInstalledAttribute()) {
        observer.disconnect();
      }
    });
    observer.observe(document, { childList: true, subtree: true });
    
    // Safety fallback
    document.addEventListener('DOMContentLoaded', setInstalledAttribute);
  }

  // Notify the web page immediately on startup that the extension is installed and ready
  window.postMessage({ type: 'ML_TRACKER_PONG', source: 'ml-price-tracker-extension' }, '*');

  window.addEventListener('message', function(event) {
    // Relaxed event.source check to support chrome/firefox isolated worlds message passing
    if (!event.data || event.data.source !== 'ml-price-tracker-web') return;

    if (event.data.type === 'ML_TRACKER_PING') {
      window.postMessage({ type: 'ML_TRACKER_PONG', source: 'ml-price-tracker-extension' }, '*');
    }

    if (event.data.type === 'ML_CONFIGURE_EXTENSION') {
      var cfg = {
        type: 'SET_CONFIG',
        apiBase: event.data.apiBase || window.location.origin,
        jwtToken: event.data.jwtToken
      };
      if (cfg.jwtToken) {
        console.log('[ML Tracker CS] Web page requested config:', cfg.apiBase);
        browserAPI.runtime.sendMessage(cfg).then(function() {
          console.log('[ML Tracker CS] Config sent from web page request');
          window.postMessage({ type: 'ML_TRACKER_CONFIGURED', source: 'ml-price-tracker-extension' }, '*');
        }).catch(function(err) {
          console.error('[ML Tracker CS] Failed to send config:', err.message);
        });
      }
    }

    if (event.data.type === 'ML_TRIGGER_SCRAPE_NOW') {
      console.log('[ML Tracker CS] Web page requested instant sync trigger');
      browserAPI.runtime.sendMessage({ type: 'TRIGGER_NOW' }).then(function() {
        console.log('[ML Tracker CS] Trigger sent successfully to background worker');
      }).catch(function(err) {
        console.error('[ML Tracker CS] Failed to send trigger to background worker:', err.message);
      });
    }
  });
})();
