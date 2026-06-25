(function() {
  var token = localStorage.getItem('ml_token');
  var apiBase = window.location.origin;

  console.log('[ML Tracker CS] Page:', apiBase, 'Has token:', !!token);

  if (token && apiBase) {
    chrome.runtime.sendMessage({
      type: 'AUTO_CONFIG',
      apiBase: apiBase,
      jwtToken: token
    }).then(function() {
      console.log('[ML Tracker CS] Auto-config sent successfully');
    }).catch(function(err) {
      console.error('[ML Tracker CS] Failed to send auto-config:', err.message);
    });

    window.postMessage({ type: 'ML_TRACKER_PONG', source: 'ml-price-tracker-extension' }, '*');
  }

  window.addEventListener('message', function(event) {
    if (event.source !== window) return;
    if (!event.data || event.data.source !== 'ml-price-tracker-web') return;

    if (event.data.type === 'ML_CONFIGURE_EXTENSION') {
      var cfg = {
        type: 'SET_CONFIG',
        apiBase: event.data.apiBase || window.location.origin,
        jwtToken: event.data.jwtToken || localStorage.getItem('ml_token')
      };
      console.log('[ML Tracker CS] Web page requested config:', cfg.apiBase);
      chrome.runtime.sendMessage(cfg).then(function() {
        console.log('[ML Tracker CS] Config sent from web page request');
        window.postMessage({ type: 'ML_TRACKER_CONFIGURED', source: 'ml-price-tracker-extension' }, '*');
      }).catch(function(err) {
        console.error('[ML Tracker CS] Failed to send config:', err.message);
      });
    }
  });
})();
