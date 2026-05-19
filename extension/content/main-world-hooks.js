// Runs in the page's MAIN world at document_start. NO chrome.* APIs are
// available here. Instrument fetch + XMLHttpRequest, then forward every
// observed request URL to the isolated-world bridge via window.postMessage.
// The isolated-world script (frame-content.js) decides what to do with it.

(function () {
  if (window.__VDL_HOOKED__) return;
  window.__VDL_HOOKED__ = true;

  const TAG = 'vdl-hook';

  // Scope postMessage to the current origin — the isolated-world bridge runs
  // in the same frame, so '*' would needlessly expose captures to any other
  // listener on the page.
  const ORIGIN = window.location.origin;
  function post(payload) {
    try {
      window.postMessage({ source: TAG, ...payload }, ORIGIN);
    } catch {
      // postMessage can throw on detached frames — swallow.
    }
  }

  function collectHeaders(input) {
    if (!input) return undefined;
    const out = {};
    try {
      if (typeof Headers !== 'undefined' && input instanceof Headers) {
        input.forEach((v, k) => {
          out[k] = v;
        });
      } else if (Array.isArray(input)) {
        for (const [k, v] of input) out[k] = v;
      } else if (typeof input === 'object') {
        for (const k of Object.keys(input)) out[k] = input[k];
      }
    } catch {
      // ignore
    }
    return Object.keys(out).length ? out : undefined;
  }

  // ---- fetch ----
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      try {
        let url;
        let headerSource;
        if (typeof input === 'string') {
          url = input;
          headerSource = init?.headers;
        } else if (input && typeof input === 'object') {
          url = input.url;
          headerSource = init?.headers ?? input.headers;
        }
        if (url) post({ kind: 'fetch', url, headers: collectHeaders(headerSource) });
      } catch {
        // never break the page over an observation failure
      }
      return origFetch.apply(this, arguments);
    };
  }

  // ---- XMLHttpRequest ----
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const origOpen = XHR.prototype.open;
    const origSetHeader = XHR.prototype.setRequestHeader;
    const origSend = XHR.prototype.send;

    XHR.prototype.open = function (method, url) {
      try {
        this.__vdlUrl = typeof url === 'string' ? url : url?.toString?.() ?? '';
        this.__vdlHeaders = undefined;
      } catch {
        // ignore
      }
      return origOpen.apply(this, arguments);
    };

    XHR.prototype.setRequestHeader = function (name, value) {
      try {
        if (!this.__vdlHeaders) this.__vdlHeaders = {};
        this.__vdlHeaders[name] = value;
      } catch {
        // ignore
      }
      return origSetHeader.apply(this, arguments);
    };

    XHR.prototype.send = function () {
      try {
        if (this.__vdlUrl) {
          post({ kind: 'xhr', url: this.__vdlUrl, headers: this.__vdlHeaders });
        }
      } catch {
        // never break the page
      }
      return origSend.apply(this, arguments);
    };
  }
})();
