import { MSG } from '../lib/messages.js';
import { classifyUrl } from '../lib/media-detection.js';

// Runs at document_start in every http(s) frame. Guard against frames whose
// protocol slipped past the manifest match (data:, blob:, javascript:).
if (/^https?:$/.test(location.protocol)) {
  const HOOK_TAG = 'vdl-hook';
  const seenInFrame = new Set();

  // Bridge from the MAIN-world fetch/XHR hooks (see main-world-hooks.js).
  // We pre-classify here so the SW only hears about media-shaped URLs.
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== HOOK_TAG) return;
    const url = typeof data.url === 'string' ? data.url : null;
    if (!url) return;
    const kind = classifyUrl(url);
    if (!kind) return;
    // Dedupe per-frame: the page may issue the same URL many times.
    if (seenInFrame.has(url)) return;
    seenInFrame.add(url);
    try {
      chrome.runtime
        .sendMessage({
          type: MSG.MEDIA_URL_DETECTED,
          payload: {
            url,
            kind,
            headers: data.headers,
            pageUrl: location.href,
            source: data.kind, // 'fetch' | 'xhr'
            frameTop: window.top === window,
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
