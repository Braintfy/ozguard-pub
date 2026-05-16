(function() {
  'use strict';

  // Хранилище — НАКАПЛИВАЕТ данные из всех API-вызовов (OZON грузит виджеты частями)
  window.__ozguard = {
    widgetStates: {},
    seo: null,
    layout: [],
    widgetCount: 0,
    callCount: 0,
    ready: false,
    method: '',
    urls: []
  };

  function mergeData(json, source) {
    if (!json) return;

    // Мержим widgetStates из каждого ответа
    if (json.widgetStates && typeof json.widgetStates === 'object') {
      Object.assign(window.__ozguard.widgetStates, json.widgetStates);
    }

    if (json.seo) window.__ozguard.seo = json.seo;
    if (json.layout && Array.isArray(json.layout)) {
      window.__ozguard.layout.push(...json.layout);
    }

    window.__ozguard.widgetCount = Object.keys(window.__ozguard.widgetStates).length;
    window.__ozguard.callCount++;
    window.__ozguard.ready = true;
    window.__ozguard.method = source;
  }

  function isApiUrl(url) {
    if (!url) return false;
    return (url.includes('/api/') || url.includes('/composer-api') || url.includes('/entrypoint-api')) &&
           (url.includes('json') || url.includes('widget') || url.includes('page'));
  }

  // === Перехват fetch ===
  const _fetch = window.fetch;
  window.fetch = async function() {
    const resp = await _fetch.apply(this, arguments);
    try {
      const url = typeof arguments[0] === 'string' ? arguments[0] : (arguments[0]?.url || '');
      if (isApiUrl(url)) {
        const clone = resp.clone();
        const json = await clone.json();
        mergeData(json, 'fetch');
        window.__ozguard.urls.push(url.substring(0, 120));
      }
    } catch (e) {}
    return resp;
  };

  // === Перехват XMLHttpRequest ===
  const _xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    this._ozgUrl = url || '';
    return _xhrOpen.apply(this, arguments);
  };

  const _xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function() {
    this.addEventListener('load', function() {
      try {
        if (isApiUrl(this._ozgUrl)) {
          const json = JSON.parse(this.responseText);
          mergeData(json, 'xhr');
          window.__ozguard.urls.push(this._ozgUrl.substring(0, 120));
        }
      } catch (e) {}
    });
    return _xhrSend.apply(this, arguments);
  };
})();
