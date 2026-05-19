import { MSG } from '../lib/messages.js';
import { pickAdapter } from '../adapters/index.js';

// Top-frame only (manifest restricts via all_frames: default false).
// Runs at document_idle so the static DOM is rendered; SPAs that fill content
// in later are caught by the adapter's observe() hook.
if (/^https?:$/.test(location.protocol)) {
  const adapter = pickAdapter(location.href, '');

  function sendPageMeta(meta) {
    try {
      chrome.runtime
        .sendMessage({
          type: MSG.PAGE_META,
          payload: { adapterId: adapter.id, meta },
        })
        .catch(() => {});
    } catch {
      // ignore (sandboxed frame, extension reloading, etc.)
    }
  }

  // Lifecycle ping (kept from v0.1 for SW visibility).
  try {
    chrome.runtime
      .sendMessage({ type: MSG.PING, payload: { context: 'page', href: location.href } })
      .catch(() => {});
  } catch {
    // ignore
  }

  // Initial scrape — synchronous, fires before observe so the SW has at
  // least something even on static pages.
  try {
    sendPageMeta(adapter.scrapePageMeta(document));
  } catch {
    // ignore broken adapter
  }

  // SPA observation. The adapter decides when "meta changed enough" to fire
  // and debounces internally.
  let cleanup = null;
  if (typeof adapter.observe === 'function') {
    try {
      cleanup = adapter.observe(document, sendPageMeta);
    } catch {
      // ignore — adapter may not support observe
    }
  }

  window.addEventListener('beforeunload', () => {
    if (typeof cleanup === 'function') cleanup();
  });
}
