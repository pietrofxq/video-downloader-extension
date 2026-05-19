import { log } from '../lib/log.js';
import { MSG } from '../lib/messages.js';
import { pickAdapter, getAdapter } from '../adapters/index.js';
import { classifyUrl, isPrimary, WEBREQUEST_PATTERNS } from '../lib/media-detection.js';
import { filterTopLevel } from '../lib/entry-filter.js';
import { parseManifest } from '../lib/m3u8.js';
import { fetchManifest } from '../lib/manifest-fetch.js';
import { sanitizeFilename } from '../lib/sanitize-filename.js';
import {
  addEntry,
  clearTab,
  getTabEntries,
  getTabState,
  getTabUrl,
  patchEntry,
  ready,
  removeTab,
  setAdapterMeta,
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
        // Only cache http(s) URLs — chrome://, devtools://, etc. will never
        // produce media detections and just bloat the store.
        if (!t.url || !/^https?:/.test(t.url)) continue;
        await setTabUrl(t.id, t.url);
      }
    } catch (err) {
      log.warn('seed tab cache failed', err);
    }
  })();
  return seedPromise;
}
seedTabs();

// ---------- Tab lifecycle ----------

const isHttpUrl = (u) => typeof u === 'string' && /^https?:/.test(u);

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.url) {
    // Initial load may give us a URL via `tab.url` before changeInfo.url ever
    // fires; cache it so detections aren't blind. Same http(s) guard as
    // seedTabs — we don't want chrome:// or devtools:// URLs in the store.
    if (isHttpUrl(tab?.url) && !(await getTabUrl(tabId))) await setTabUrl(tabId, tab.url);
    return;
  }
  if (!isHttpUrl(changeInfo.url)) return;
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
      frameId: details.frameId,
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
      frameId: details.frameId,
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
        frameId: sender.frameId ?? 0,
        kind,
        headers: p.headers,
        pageUrl: sender.tab?.url || '',
        source: `frame:${p.source ?? 'unknown'}`,
      });
      sendResponse({ ok: true });
      return false;
    }
    case MSG.MANIFEST_BODY: {
      const tabId = sender.tab?.id;
      const { url, text } = msg.payload ?? {};
      if (tabId == null || tabId < 0 || typeof url !== 'string' || typeof text !== 'string') {
        sendResponse({ ok: false });
        return false;
      }
      void handleManifestBody(tabId, url, text);
      sendResponse({ ok: true });
      return false;
    }
    case MSG.PAGE_META: {
      const tabId = sender.tab?.id;
      if (tabId == null || tabId < 0) {
        sendResponse({ ok: false });
        return false;
      }
      const { adapterId, meta } = msg.payload ?? {};
      if (!adapterId || !meta || typeof meta !== 'object') {
        sendResponse({ ok: false });
        return false;
      }
      void handlePageMeta(tabId, adapterId, meta);
      sendResponse({ ok: true });
      return false;
    }
    case MSG.START_DOWNLOAD: {
      const p = msg.payload ?? {};
      if (typeof p.mediaId !== 'string') {
        sendResponse({ ok: false, error: 'missing mediaId' });
        return false;
      }
      handleStartDownload(p)
        .then((res) => sendResponse({ ok: true, ...res }))
        .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
      return true; // async
    }
    case MSG.PROXY_FETCH: {
      const p = msg.payload ?? {};
      if (typeof p.url !== 'string' || typeof p.tabId !== 'number') {
        sendResponse({ ok: false, error: 'missing url/tabId' });
        return false;
      }
      handleProxyFetch(p)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
      return true; // async
    }
    case MSG.DOWNLOAD_PROGRESS: {
      // Offscreen → popup forwarder. v0.6 just logs; v0.8 wires the popup.
      log.debug('download progress', msg.payload);
      sendResponse({ ok: true });
      return false;
    }
    case MSG.DOWNLOAD_DONE: {
      // Offscreen has produced a Blob URL; trigger the actual save.
      handleDownloadDone(msg.payload).catch((err) => log.warn('downloads.download failed', err));
      sendResponse({ ok: true });
      return false;
    }
    case MSG.DOWNLOAD_ERROR: {
      log.warn('download error', msg.payload);
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

async function handleDetection({ url, tabId, frameId, kind, headers, pageUrl, source }) {
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
    // frameId is what we'll route PROXY_FETCH requests to in v0.6+ — the
    // frame that originated the manifest fetch has the right Origin/Referer
    // for the CDN's signed-URL check.
    frameId: typeof frameId === 'number' ? frameId : 0,
    ...(headers ? { headers } : {}),
  };

  const stored = await addEntry(tabId, entry);
  if (!stored) return; // dedupe hit

  log.info('media detected', { tabId, kind, adapter: adapter.id, source, url });

  await updateBadge(tabId);
  await broadcastTabState(tabId);

  // Eagerly parse HLS manifests so the popup's quality dropdown is ready
  // by the time the user opens it. ensureParsed is idempotent.
  if (stored.kind === 'hls') {
    void ensureParsed(tabId, stored);
  }
}

// ---------- Manifest parsing ----------

const inFlightParses = new Set(); // `${tabId}:${mediaId}` while a parse is running

async function ensureParsed(tabId, entry) {
  if (entry.variants || entry.parseError) return; // already done or terminally failed
  const key = `${tabId}:${entry.id}`;
  if (inFlightParses.has(key)) return;
  inFlightParses.add(key);
  try {
    const adapter = getAdapter(entry.adapterId);
    const headers = adapter.transformHeaders?.(entry.headers ?? {}) ?? entry.headers ?? {};
    const { text, finalUrl } = await fetchManifest(entry.url, headers);

    // Race-check: a manifest-body capture may have populated this entry
    // while our fetch was in flight. The body capture is preferred (it
    // hits the player's cookies/origin, which is exactly what signed-URL
    // CDNs validate against).
    if (await entryIsResolved(tabId, entry.id)) return;

    const parsed = parseManifest(text, finalUrl);
    await patchEntry(tabId, entry.id, {
      isMaster: parsed.isMaster,
      variants: parsed.variants,
      alternates: parsed.alternates,
      segmentCount: parsed.segmentCount,
    });
    log.info('parsed manifest (sw fetch)', {
      tabId,
      mediaId: entry.id,
      isMaster: parsed.isMaster,
      variants: parsed.variants.length,
    });
    await updateBadge(tabId);
  } catch (err) {
    // Race-check again before recording a parse error — body capture
    // may have already succeeded.
    if (await entryIsResolved(tabId, entry.id)) return;
    const message = String(err?.message ?? err);
    await patchEntry(tabId, entry.id, { parseError: message });
    log.warn('manifest parse failed', { tabId, mediaId: entry.id, err: message });
  } finally {
    inFlightParses.delete(key);
  }
  await broadcastTabState(tabId);
}

// ---------- Download orchestration ----------

const OFFSCREEN_URL = chrome.runtime.getURL('offscreen/offscreen.html');
let ensureOffscreenPromise = null;

async function ensureOffscreen() {
  // Memoize while creating; subsequent calls during creation share the
  // promise. After creation completes, future calls find the document
  // already open via getContexts and return cheaply.
  if (ensureOffscreenPromise) return ensureOffscreenPromise;
  ensureOffscreenPromise = (async () => {
    try {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
      });
      if (contexts.some((c) => c.documentUrl === OFFSCREEN_URL)) return;
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: ['BLOBS', 'WORKERS'],
        justification: 'Decrypt + concatenate HLS segments and host the Blob URL for download.',
      });
    } finally {
      // Allow re-checking on a later download in case the document was
      // closed between calls.
      ensureOffscreenPromise = null;
    }
  })();
  return ensureOffscreenPromise;
}

async function handleStartDownload(payload) {
  const { mediaId, variantUrl } = payload;
  const tabState = await Promise.resolve(); // no-op; documents the await chain below
  void tabState;
  // Find the MediaEntry across all tabs.
  let entry = null;
  let entryTabId = null;
  const states = popupPortsTabs();
  for (const tabId of states) {
    const s = await getTabState(tabId);
    const found = s.entries.find((e) => e.id === mediaId);
    if (found) {
      entry = found;
      entryTabId = tabId;
      break;
    }
  }
  if (!entry) {
    // Fallback: scan every tab we know about. (popupPortsTabs only covers
    // tabs with an open popup — narrower than tabState.)
    const allTabIds = await listTrackedTabs();
    for (const tabId of allTabIds) {
      const s = await getTabState(tabId);
      const found = s.entries.find((e) => e.id === mediaId);
      if (found) {
        entry = found;
        entryTabId = tabId;
        break;
      }
    }
  }
  if (!entry) throw new Error(`unknown mediaId: ${mediaId}`);

  if (entry.kind !== 'hls') {
    throw new Error(`v0.6 supports HLS only; this entry is ${entry.kind}`);
  }

  const adapter = getAdapter(entry.adapterId);
  const meta = entry.meta ?? {};
  const baseName = adapter.deriveFilename({
    pageMeta: meta,
    url: entry.url,
    mediaEntry: entry,
  });
  const filename = sanitizeFilename(baseName, { fallback: 'video' });

  const requestId = crypto.randomUUID();
  const finalVariantUrl = variantUrl && /^https?:/.test(variantUrl) ? variantUrl : entry.url;

  await ensureOffscreen();
  // SW → offscreen uses RUN_DOWNLOAD so it doesn't collide with the
  // popup→SW START_DOWNLOAD message on the broadcast bus.
  void chrome.runtime
    .sendMessage({
      type: MSG.RUN_DOWNLOAD,
      payload: {
        requestId,
        variantUrl: finalVariantUrl,
        tabId: entryTabId,
        frameId: entry.frameId ?? 0,
        headers: entry.headers,
        filename,
      },
    })
    .catch((err) => log.warn('forward RUN_DOWNLOAD to offscreen failed', err));

  log.info('download started', {
    requestId,
    mediaId,
    tabId: entryTabId,
    frameId: entry.frameId ?? 0,
    adapter: entry.adapterId,
    filename: `${filename}.ts`,
  });
  return { requestId, filename: `${filename}.ts` };
}

async function handleProxyFetch({ tabId, frameId, url, headers, responseType }) {
  // Forward to the content script in the target frame. Its fetch goes out
  // with the page's Origin/Referer + cookies, which signed-URL CDNs check.
  try {
    const reply = await chrome.tabs.sendMessage(
      tabId,
      { type: MSG.PROXY_FETCH, payload: { url, headers, responseType } },
      { frameId: typeof frameId === 'number' ? frameId : 0 },
    );
    return reply;
  } catch (err) {
    // Frame may have closed / navigated away. Surface as an explicit error.
    return { ok: false, error: `proxy unreachable: ${err?.message ?? err}` };
  }
}

async function handleDownloadDone(payload) {
  if (!payload || typeof payload.blobUrl !== 'string') return;
  const downloadId = await chrome.downloads.download({
    url: payload.blobUrl,
    filename: payload.filename,
    saveAs: false,
  });
  log.info('chrome.downloads accepted', {
    downloadId,
    filename: payload.filename,
    bytes: payload.bytes,
    segments: payload.segments,
  });
  // Revoke the offscreen Blob URL once the download lands or is interrupted.
  const listener = (delta) => {
    if (delta.id !== downloadId) return;
    if (delta.state?.current === 'complete' || delta.state?.current === 'interrupted') {
      chrome.downloads.onChanged.removeListener(listener);
      // Asking the offscreen to revoke the URL would be ideal; we keep the
      // doc alive (single shared instance) so it naturally goes away when
      // the extension reloads.
    }
  };
  chrome.downloads.onChanged.addListener(listener);
}

// Helper: enumerate tabIds currently subscribed via popup ports. Cheap
// fast-path for handleStartDownload (the popup is the only context that
// can call START_DOWNLOAD, so the active tab is almost always covered).
function popupPortsTabs() {
  const out = new Set();
  for (const info of popupPorts.values()) {
    if (typeof info.tabId === 'number') out.add(info.tabId);
  }
  return out;
}

async function listTrackedTabs() {
  // chrome.storage.session has the mediaState dump; mining keys is cheaper
  // than maintaining a parallel index for v0.6.
  try {
    const got = await chrome.storage.session.get('mediaState');
    return got.mediaState ? Object.keys(got.mediaState).map(Number) : [];
  } catch {
    return [];
  }
}

async function entryIsResolved(tabId, mediaId) {
  const state = await getTabState(tabId);
  const fresh = state.entries.find((e) => e.id === mediaId);
  return !!(fresh && fresh.variants);
}

async function handleManifestBody(tabId, url, text) {
  await seedTabs();
  const state = await getTabState(tabId);
  const entry = state.entries.find((e) => e.url === url);
  if (!entry) {
    // Body arrived before the entry. Rare in practice — webRequest fires
    // before the response resolves — but possible if the SW just restarted.
    log.debug('manifest body for unknown entry', { tabId, url });
    return;
  }
  if (entry.kind !== 'hls') {
    // m3u8-parser silently returns empty success on DASH/.mpd input, which
    // would mislabel the entry as "Single quality". v1.1's mpd-parser will
    // route DASH bodies through its own handler.
    log.debug('skipping body capture for non-hls kind', { kind: entry.kind, url });
    return;
  }
  if (entry.variants) return; // already parsed (we win the race only once)
  try {
    const parsed = parseManifest(text, url);
    // Clear any prior parseError — body capture overrides a failed SW fetch.
    await patchEntry(tabId, entry.id, {
      isMaster: parsed.isMaster,
      variants: parsed.variants,
      alternates: parsed.alternates,
      segmentCount: parsed.segmentCount,
      parseError: null,
    });
    log.info('parsed manifest (body capture)', {
      tabId,
      mediaId: entry.id,
      isMaster: parsed.isMaster,
      variants: parsed.variants.length,
    });
    await updateBadge(tabId);
    await broadcastTabState(tabId);
  } catch (err) {
    const message = String(err?.message ?? err);
    log.warn('parse from body failed', { tabId, mediaId: entry.id, err: message });
    // Don't set parseError — the SW fallback fetch may still succeed.
  }
}

async function updateBadge(tabId) {
  // Count only top-level (user-visible) entries — what the popup actually
  // renders. Raw entry count is misleading because variants/alternates
  // collapse under their master.
  const entries = await getTabEntries(tabId);
  const count = filterTopLevel(entries).length;
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

async function handlePageMeta(tabId, adapterId, meta) {
  await seedTabs();
  const { changed } = await setAdapterMeta(tabId, adapterId, meta);
  log.info('page meta', { tabId, adapterId, changed, meta });
  // Only broadcast when something actually changed. setAdapterMeta returns
  // changed: false when the new meta is shallow-equal to the stored value
  // (frequent on Hotmart re-renders) — popups that opened later can pull
  // current state via GET_TAB_STATE.
  if (changed) await broadcastTabState(tabId);
}

// ---------- Popup port subscriptions ----------
//
// Popups (and any future long-lived listener) open a port named 'popup',
// SUBSCRIBE to a specific tabId, and receive STATE messages on every
// change for that tab. Replaces the v0.2 chrome.runtime.sendMessage
// broadcast — only interested ports get the update.

const popupPorts = new Map(); // port -> { tabId | null }

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'popup') return;
  popupPorts.set(port, { tabId: null });
  port.onMessage.addListener(async (msg) => {
    if (msg?.type !== 'SUBSCRIBE') return;
    const tabId = typeof msg.tabId === 'number' ? msg.tabId : null;
    popupPorts.set(port, { tabId });
    if (tabId == null) return;
    try {
      const state = await getTabState(tabId);
      port.postMessage({ type: 'STATE', state });
      // Schedule parsing for any HLS entries whose manifest hasn't been
      // fetched yet. Covers SW restart (in-flight Set is empty on cold
      // start, so previously interrupted parses get retried).
      for (const entry of state.entries) {
        if (entry.kind === 'hls' && !entry.variants && !entry.parseError) {
          void ensureParsed(tabId, entry);
        }
      }
    } catch (err) {
      log.warn('initial popup SUBSCRIBE state failed', err);
    }
  });
  port.onDisconnect.addListener(() => {
    popupPorts.delete(port);
  });
});

async function broadcastTabState(tabId) {
  if (popupPorts.size === 0) return;
  const state = await getTabState(tabId);
  for (const [port, info] of popupPorts) {
    if (info.tabId !== tabId) continue;
    try {
      port.postMessage({ type: 'STATE', state });
    } catch {
      // Port disconnected mid-send; onDisconnect will clean up the entry.
    }
  }
}

