import { MSG } from '../lib/messages.js';
import { pickAdapter } from '../adapters/index.js';
import type { DiscoveredStream, PageMeta } from '../lib/types.ts';

// The double-injection guard flag + the Navigation API need a typed
// window surface. We declare them ambiently in this file rather than in
// external-modules.d.ts because they're truly local to the content
// scripts (the Navigation API isn't exposed in SW or offscreen).
declare global {
  interface Window {
    __VDL_PAGE_CONTENT_INSTALLED__?: boolean;
    __VDL_HOOKED__?: boolean;
  }
}

// Top-frame only (manifest restricts via all_frames: default false).
// Runs at document_idle so the static DOM is rendered; SPAs that fill content
// in later are caught by the adapter's observe() hook.
//
// Double-injection guard: on extension reload / hot-reinstall the script can
// re-execute against a page that still has the prior instance's listeners.
// The flag prevents a second set of nav listeners (and a second observer)
// from piling on, which would otherwise fire sendPageMeta twice per event.
if (/^https?:$/.test(location.protocol) && !window.__VDL_PAGE_CONTENT_INSTALLED__) {
  window.__VDL_PAGE_CONTENT_INSTALLED__ = true;
  let cleanup: (() => void) | null = null;

  function sendPageMeta(adapterId: string, meta: PageMeta): void {
    try {
      chrome.runtime
        .sendMessage({ type: MSG.PAGE_META, payload: { adapterId, meta } })
        .catch(() => {});
    } catch {
      // ignore (sandboxed frame, extension reloading, etc.)
    }
  }

  function sendStreamsDiscovered(adapterId: string, streams: DiscoveredStream[]): void {
    // Skip the round-trip when there's nothing to publish.
    if (!streams || streams.length === 0) return;
    try {
      chrome.runtime
        .sendMessage({ type: MSG.STREAMS_DISCOVERED, payload: { adapterId, streams } })
        .catch(() => {});
    } catch {
      // ignore
    }
  }

  function publishAdapterState(adapter: ReturnType<typeof pickAdapter>, meta: PageMeta): void {
    sendPageMeta(adapter.id, meta);
    if (typeof adapter.discoverStreams === 'function') {
      // Adapters can return synchronously (default / hotmart) or
      // asynchronously (youtube — InnerTube fetch). Promise.resolve
      // normalizes both shapes; failures (sync throw or rejection)
      // are swallowed because discovery is best-effort.
      Promise.resolve()
        .then(() => adapter.discoverStreams!(document))
        .then((streams) => sendStreamsDiscovered(adapter.id, streams))
        .catch(() => {
          // ignore — adapter discovery is best-effort
        });
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
      publishAdapterState(adapter, adapter.scrapePageMeta(document));
    } catch {
      // ignore broken adapter
    }
    if (typeof adapter.observe === 'function') {
      try {
        cleanup = adapter.observe(document, (meta) => publishAdapterState(adapter, meta));
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
    // navigatesuccess fires AFTER location.href is updated. The older
    // 'navigate' event fires before commit, so reading location.href there
    // would be stale and forced a microtask defer hack.
    window.navigation.addEventListener('navigatesuccess', setupForCurrentUrl);
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
