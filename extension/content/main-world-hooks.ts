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

  function post(payload: Record<string, unknown>): void {
    try {
      window.postMessage({ source: TAG, ...payload }, ORIGIN);
    } catch {
      // postMessage can throw on detached frames — swallow.
    }
  }

  // Pages frequently call `fetch('/master.m3u8')` with a relative path.
  // webRequest stores absolute URLs, and the SW matches body-capture by
  // exact URL string equality (handleManifestBody → entry.url === url).
  // Resolve against the current document so both sides see the same URL.
  function absolutize(url: string): string {
    if (typeof url !== 'string' || url.length === 0) return url;
    try {
      return new URL(url, window.location.href).href;
    } catch {
      return url;
    }
  }

  function collectHeaders(input: unknown): Record<string, string> | undefined {
    if (!input) return undefined;
    const out: Record<string, string> = {};
    try {
      if (typeof Headers !== 'undefined' && input instanceof Headers) {
        input.forEach((v: string, k: string) => {
          out[k] = v;
        });
      } else if (Array.isArray(input)) {
        for (const [k, v] of input as Array<[string, string]>) out[k] = v;
      } else if (typeof input === 'object') {
        for (const k of Object.keys(input as object)) {
          out[k] = String((input as Record<string, unknown>)[k]);
        }
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
  function isManifestUrl(url: string): boolean {
    if (typeof url !== 'string') return false;
    return /\.m3u8(?:[?&#]|$)/i.test(url) || /\.mpd(?:[?&#]|$)/i.test(url);
  }

  // ---- fetch ----
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (
      this: typeof window,
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      let url: string | undefined;
      let headerSource: HeadersInit | undefined;
      try {
        if (typeof input === 'string') {
          url = input;
          headerSource = init?.headers;
        } else if (input instanceof URL) {
          url = input.href;
          headerSource = init?.headers;
        } else if (input && typeof input === 'object') {
          url = (input as Request).url;
          headerSource = init?.headers ?? (input as Request).headers;
        }
      } catch {
        // never break the page over an observation failure
      }
      // eslint-disable-next-line prefer-rest-params
      const promise = origFetch.apply(this, arguments as unknown as Parameters<typeof fetch>);
      if (url) {
        const absUrl = absolutize(url);
        try {
          post({ kind: 'fetch', url: absUrl, headers: collectHeaders(headerSource) });
        } catch {
          // ignore
        }
        if (isManifestUrl(absUrl)) {
          // Clone is essential — reading the body would consume the
          // player's stream. Send the text body once available.
          promise
            .then(async (res: Response) => {
              try {
                if (!res || !res.ok) return;
                const text = await res.clone().text();
                post({ kind: 'manifest-body', url: absUrl, text });
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

    // We tag XHR instances with __vdlUrl / __vdlHeaders /
    // __vdlManifestListenerAdded so the patched .send() can read the
    // url+headers the page set during .open() / .setRequestHeader(). The
    // interface widens the runtime XHR with these fields.
    interface VdlXHR extends XMLHttpRequest {
      __vdlUrl?: string;
      __vdlHeaders?: Record<string, string>;
      __vdlManifestListenerAdded?: boolean;
    }

    XHR.prototype.open = function (this: VdlXHR, _method: string, url: string | URL) {
      try {
        const raw = typeof url === 'string' ? url : (url?.toString?.() ?? '');
        this.__vdlUrl = absolutize(raw);
        this.__vdlHeaders = undefined;
      } catch {
        // ignore
      }
      // eslint-disable-next-line prefer-rest-params
      return origOpen.apply(this, arguments as unknown as Parameters<XMLHttpRequest['open']>);
    };

    XHR.prototype.setRequestHeader = function (this: VdlXHR, name: string, value: string) {
      try {
        if (!this.__vdlHeaders) this.__vdlHeaders = {};
        this.__vdlHeaders[name] = value;
      } catch {
        // ignore
      }
      return origSetHeader.apply(this, [name, value]);
    };

    XHR.prototype.send = function (this: VdlXHR) {
      try {
        if (this.__vdlUrl) {
          post({ kind: 'xhr', url: this.__vdlUrl, headers: this.__vdlHeaders });
          if (isManifestUrl(this.__vdlUrl) && !this.__vdlManifestListenerAdded) {
            // Some clients reuse an XHR instance across multiple requests
            // (rare for HLS players but possible). The flag prevents
            // accumulating duplicate listeners on the same instance.
            this.__vdlManifestListenerAdded = true;
            // eslint-disable-next-line @typescript-eslint/no-this-alias
            const xhr: VdlXHR = this;
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
      // eslint-disable-next-line prefer-rest-params
      return origSend.apply(this, arguments as unknown as Parameters<XMLHttpRequest['send']>);
    };
  }
})();
