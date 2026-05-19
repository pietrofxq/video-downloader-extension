// Runs in the page's MAIN world at document_start. NO chrome.* APIs are
// available here. Instrument fetch + XMLHttpRequest, then forward every
// observed request URL to the isolated-world bridge via window.postMessage.
// The isolated-world script (frame-content.js) decides what to do with it.
//
// As of v0.5 we ALSO capture manifest response bodies (m3u8/mpd) and
// forward them. SW fetches from chrome-extension:// origin are commonly
// rejected by signed-URL CDNs (e.g., Hotmart's Akamai 403s on Origin),
// so the SW reads the body the player already fetched instead.

(function () {
  if (window.__VDL_HOOKED__) return;
  window.__VDL_HOOKED__ = true;

  const TAG = 'vdl-hook';
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

  // m3u8 / mpd manifest URLs — we want their bodies for parsing.
  // Note: false positives are fine (the isolated-world bridge will reject
  // anything that classifyUrl can't tag).
  // The `[?&#]` class catches `.m3u8` followed by `&` mid-query too
  // (e.g. ?file=video.m3u8&token=...), not just at the end of the path.
  function isManifestUrl(url) {
    if (typeof url !== 'string') return false;
    return /\.m3u8(?:[?&#]|$)/i.test(url) || /\.mpd(?:[?&#]|$)/i.test(url);
  }

  // ---- fetch ----
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      let url;
      let headerSource;
      try {
        if (typeof input === 'string') {
          url = input;
          headerSource = init?.headers;
        } else if (input && typeof input === 'object') {
          url = input.url;
          headerSource = init?.headers ?? input.headers;
        }
      } catch {
        // never break the page over an observation failure
      }
      const promise = origFetch.apply(this, arguments);
      if (url) {
        try {
          post({ kind: 'fetch', url, headers: collectHeaders(headerSource) });
        } catch {
          // ignore
        }
        if (isManifestUrl(url)) {
          // Clone is essential — reading the body would consume the
          // player's stream. Send the text body once available.
          promise
            .then(async (res) => {
              try {
                if (!res || !res.ok) return;
                const text = await res.clone().text();
                post({ kind: 'manifest-body', url, text });
              } catch {
                // body unreadable — leave it; SW fallback will try fetch.
              }
            })
            .catch(() => {});
        }
      }
      return promise;
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
          if (isManifestUrl(this.__vdlUrl) && !this.__vdlManifestListenerAdded) {
            // Some clients reuse an XHR instance across multiple requests
            // (rare for HLS players but possible). The flag prevents
            // accumulating duplicate listeners on the same instance.
            this.__vdlManifestListenerAdded = true;
            const xhr = this;
            xhr.addEventListener('load', function () {
              try {
                if (xhr.status >= 200 && xhr.status < 300 && typeof xhr.responseText === 'string') {
                  post({ kind: 'manifest-body', url: xhr.__vdlUrl, text: xhr.responseText });
                }
              } catch {
                // ignore
              }
            });
          }
        }
      } catch {
        // never break the page
      }
      return origSend.apply(this, arguments);
    };
  }
})();
