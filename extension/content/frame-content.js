import { MSG } from '../lib/messages.js';
import { classifyUrl } from '../lib/media-detection.js';

// Runs at document_start in every http(s) frame. Guard against frames whose
// protocol slipped past the manifest match (data:, blob:, javascript:).
if (/^https?:$/.test(location.protocol)) {
  const HOOK_TAG = 'vdl-hook';
  const PAGE_ORIGIN = window.location.origin;
  const SEEN_LIMIT = 500;

  // Bounded LRU-ish dedupe: Sets preserve insertion order, so dropping the
  // first value approximates "oldest". A long-lived SPA (Hotmart Club scrubs
  // through many lessons) can otherwise grow this set unboundedly.
  const seenInFrame = new Set();
  function markSeen(url) {
    if (seenInFrame.has(url)) return false;
    if (seenInFrame.size >= SEEN_LIMIT) {
      const oldest = seenInFrame.values().next().value;
      seenInFrame.delete(oldest);
    }
    seenInFrame.add(url);
    return true;
  }

  // Bridge from the MAIN-world fetch/XHR hooks (see main-world-hooks.js).
  //
  // No race in practice between the two worlds: the main-world script's only
  // startup work is monkey-patching fetch + XHR.prototype. It does NOT
  // postMessage at startup — those calls fire later when the page makes its
  // own network requests, by which time this addEventListener('message') is
  // installed.
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.origin !== PAGE_ORIGIN) return;
    const data = event.data;
    if (!data || data.source !== HOOK_TAG) return;
    const url = typeof data.url === 'string' ? data.url : null;
    if (!url) return;

    // Manifest body capture: the player's fetch already succeeded with the
    // right Origin/Referer, so reuse that body instead of re-fetching from
    // the SW (which gets 403'd by signed-URL CDNs). Bypasses dedupe — the
    // body arrives separately from the URL observation.
    if (data.kind === 'manifest-body' && typeof data.text === 'string') {
      try {
        chrome.runtime
          .sendMessage({
            type: MSG.MANIFEST_BODY,
            payload: { url, text: data.text },
          })
          .catch(() => {});
      } catch {
        // ignore
      }
      return;
    }

    const kind = classifyUrl(url);
    if (!kind) return;
    if (!markSeen(url)) return;
    try {
      chrome.runtime
        .sendMessage({
          type: MSG.MEDIA_URL_DETECTED,
          payload: {
            url,
            kind,
            headers: data.headers,
            source: data.kind, // 'fetch' | 'xhr'
          },
        })
        .catch(() => {});
    } catch {
      // Some sandboxed frames will throw on chrome.runtime access — swallow.
    }
  });

  // Lifecycle ping (kept from v0.1 for SW visibility).
  try {
    chrome.runtime
      .sendMessage({
        type: MSG.PING,
        payload: { context: 'frame', href: location.href, top: window.top === window },
      })
      .catch(() => {});
  } catch {
    // ignore
  }
}
