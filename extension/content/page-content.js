import { MSG } from '../lib/messages.js';
import { pickAdapter } from '../adapters/index.js';

// Top-frame only (manifest restricts via all_frames: default false).
// Runs at document_idle so the static DOM is rendered; SPAs that fill content
// in later are caught by the adapter's observe() hook.
if (/^https?:$/.test(location.protocol)) {
  let cleanup = null;

  function sendPageMeta(adapterId, meta) {
    try {
      chrome.runtime
        .sendMessage({ type: MSG.PAGE_META, payload: { adapterId, meta } })
        .catch(() => {});
    } catch {
      // ignore (sandboxed frame, extension reloading, etc.)
    }
  }

  // Picks the adapter for the *current* URL, tears down any prior observer,
  // emits an initial scrape, and installs a new observer. Called on first
  // load and on every SPA navigation we can detect.
  function setupForCurrentUrl() {
    if (typeof cleanup === 'function') {
      try {
        cleanup();
      } catch {
        // ignore
      }
      cleanup = null;
    }
    const adapter = pickAdapter(location.href, '');
    try {
      sendPageMeta(adapter.id, adapter.scrapePageMeta(document));
    } catch {
      // ignore broken adapter
    }
    if (typeof adapter.observe === 'function') {
      try {
        cleanup = adapter.observe(document, (meta) => sendPageMeta(adapter.id, meta));
      } catch {
        // ignore — adapter may not support observe
      }
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

  setupForCurrentUrl();

  // SPA navigation. popstate covers back/forward; hashchange covers anchor
  // nav. pushState/replaceState don't fire either of those — the Navigation
  // API (Chrome 102+, we target 120+) is the only standards-track signal
  // that catches them.
  window.addEventListener('popstate', setupForCurrentUrl);
  window.addEventListener('hashchange', setupForCurrentUrl);
  if (window.navigation && typeof window.navigation.addEventListener === 'function') {
    window.navigation.addEventListener('navigate', () => {
      // Defer one tick so location.href reflects the destination URL when
      // setupForCurrentUrl reads it.
      Promise.resolve().then(setupForCurrentUrl);
    });
  }

  // Tear-down. Listen for both — beforeunload is the historical hook;
  // pagehide is the modern one and fires reliably in bfcache + mobile
  // suspend scenarios where beforeunload may not.
  const teardown = () => {
    if (typeof cleanup === 'function') {
      try {
        cleanup();
      } catch {
        // ignore
      }
      cleanup = null;
    }
  };
  window.addEventListener('beforeunload', teardown);
  window.addEventListener('pagehide', teardown);
}
