import { log } from '../lib/log.js';
import { MSG, envelope } from '../lib/messages.js';
import { pickAdapter } from '../adapters/index.js';
import { classifyUrl, isPrimary, WEBREQUEST_PATTERNS } from '../lib/media-detection.js';
import {
  addEntry,
  clearTab,
  getTabEntries,
  getTabState,
  getTabUrl,
  ready,
  removeTab,
  setTabUrl,
} from '../lib/media-store.js';

const BADGE_COLOR = '#ff5d2e';

log.info('SW alive');

chrome.runtime.onInstalled.addListener((details) => {
  log.info('SW installed:', details.reason);
});

// Seed the tab-URL cache so detections that race ahead of webNavigation pick
// up the right pageUrl. Memoized one-shot — handleDetection awaits this so
// the first wave of webRequest events never sees an empty cache.
let seedPromise = null;
function seedTabs() {
  if (seedPromise) return seedPromise;
  seedPromise = (async () => {
    try {
      await ready();
      const tabs = await chrome.tabs.query({});
      for (const t of tabs) {
        if (t.id == null || t.id < 0) continue;
        if (t.url) await setTabUrl(t.id, t.url);
      }
    } catch (err) {
      log.warn('seed tab cache failed', err);
    }
  })();
  return seedPromise;
}
seedTabs();

// ---------- Tab lifecycle ----------

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.url) {
    // Initial load may give us a URL via `tab.url` before changeInfo.url ever
    // fires; cache it so detections aren't blind.
    if (tab?.url && !(await getTabUrl(tabId))) await setTabUrl(tabId, tab.url);
    return;
  }
  const { prev } = await setTabUrl(tabId, changeInfo.url);
  if (prev && prev !== changeInfo.url) {
    const had = await clearTab(tabId);
    if (had) await updateBadge(tabId);
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await removeTab(tabId);
});

// ---------- webRequest observation ----------

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return; // extension/background requests
    const kind = classifyUrl(details.url);
    if (!kind) return;
    void handleDetection({
      url: details.url,
      tabId: details.tabId,
      kind,
      source: 'webRequest',
    });
  },
  { urls: [...WEBREQUEST_PATTERNS] },
);

// Re-classify with Content-Type for URLs that don't have a clean extension.
// Cheap: we only run for URLs already matched by the broad pattern set.
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const byUrl = classifyUrl(details.url);
    if (byUrl) return; // already handled in onBeforeRequest
    const ct = (details.responseHeaders ?? []).find(
      (h) => h.name.toLowerCase() === 'content-type',
    )?.value;
    const kind = classifyUrl(details.url, ct);
    if (!kind) return;
    void handleDetection({
      url: details.url,
      tabId: details.tabId,
      kind,
      source: 'webRequest-ct',
    });
  },
  { urls: [...WEBREQUEST_PATTERNS] },
  ['responseHeaders'],
);

// ---------- MV3 message handler ----------
//
// MV3 message handler contract: return `true` from this listener if you call
// sendResponse asynchronously, otherwise the channel closes and the sender's
// promise rejects. Synchronous handlers can return `false` (or nothing).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;
  switch (msg.type) {
    case MSG.PING: {
      const tabId = sender.tab?.id ?? null;
      const frame = sender.frameId ?? null;
      const pageUrl = sender.tab?.url ?? sender.url ?? '';
      const adapter = pickAdapter(pageUrl, '');
      log.info('PING from', {
        tabId,
        frame,
        pageUrl,
        adapter: adapter.id,
        context: msg.payload?.context,
      });
      sendResponse({ ok: true, adapter: adapter.id });
      return false;
    }
    case MSG.MEDIA_URL_DETECTED: {
      const tabId = sender.tab?.id;
      const p = msg.payload ?? {};
      if (tabId == null || tabId < 0 || typeof p.url !== 'string') {
        sendResponse({ ok: false });
        return false;
      }
      const kind = p.kind || classifyUrl(p.url);
      if (!kind) {
        sendResponse({ ok: false });
        return false;
      }
      // sender.tab.url is always the top-level tab URL, even when the message
      // came from a sub-frame. The bridge intentionally does NOT send pageUrl
      // (which would be the iframe URL) — see frame-content.js.
      void handleDetection({
        url: p.url,
        tabId,
        kind,
        headers: p.headers,
        pageUrl: sender.tab?.url || '',
        source: `frame:${p.source ?? 'unknown'}`,
      });
      sendResponse({ ok: true });
      return false;
    }
    case MSG.GET_TAB_STATE: {
      const reqTab = msg.payload?.tabId ?? sender.tab?.id;
      if (reqTab == null) {
        sendResponse({ ok: false });
        return false;
      }
      getTabState(reqTab)
        .then((state) => sendResponse({ ok: true, state }))
        .catch((err) => {
          log.warn('GET_TAB_STATE failed', err);
          sendResponse({ ok: false });
        });
      return true; // async sendResponse
    }
    default:
      return false;
  }
});

// ---------- Detection pipeline ----------

async function handleDetection({ url, tabId, kind, headers, pageUrl, source }) {
  // For v0.2 only primary kinds populate the user-visible list. We still log
  // segment/key observations so dev sanity-checks have something to read.
  if (!isPrimary(kind)) {
    log.debug('observed', { kind, url, source });
    return;
  }

  // Block until the tab-URL cache is populated. Without this, the first wave
  // of webRequest events races ahead of seedTabs() and falls through to the
  // default adapter even on tabs we know about.
  await seedTabs();

  let resolvedPageUrl = pageUrl;
  if (!resolvedPageUrl) {
    resolvedPageUrl = await getTabUrl(tabId);
  }
  if (!resolvedPageUrl) {
    try {
      const tab = await chrome.tabs.get(tabId);
      resolvedPageUrl = tab.url ?? '';
    } catch (err) {
      log.warn('chrome.tabs.get failed', { tabId, err: String(err?.message ?? err) });
      resolvedPageUrl = '';
    }
  }
  if (resolvedPageUrl) await setTabUrl(tabId, resolvedPageUrl);

  const adapter = pickAdapter(resolvedPageUrl, url);
  const entry = {
    kind,
    url,
    pageUrl: resolvedPageUrl,
    adapterId: adapter.id,
    capturedAt: Date.now(),
    ...(headers ? { headers } : {}),
  };

  const stored = await addEntry(tabId, entry);
  if (!stored) return; // dedupe hit

  log.info('media detected', { tabId, kind, adapter: adapter.id, source, url });

  await updateBadge(tabId);
  await broadcastTabState(tabId);
}

async function updateBadge(tabId) {
  const entries = await getTabEntries(tabId);
  const count = entries.length;
  try {
    await chrome.action.setBadgeText({ tabId, text: count > 0 ? String(count) : '' });
    if (count > 0) {
      await chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOR });
    }
  } catch (err) {
    // setBadge* throws if the tab no longer exists; not fatal.
    log.debug('updateBadge skipped', err);
  }
}

async function broadcastTabState(tabId) {
  const state = await getTabState(tabId);
  // Fire-and-forget: popup may be closed and the message will reject; that's
  // fine. We catch to avoid an unhandled rejection.
  chrome.runtime
    .sendMessage(envelope(MSG.TAB_STATE_UPDATED, { tabId, state }))
    .catch(() => {});
}

