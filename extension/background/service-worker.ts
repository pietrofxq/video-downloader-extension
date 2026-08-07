import { log } from '../lib/log.js';
import { MSG, assertNever, parseExtensionMessage } from '../lib/messages.js';
import { pickAdapter, getAdapter } from '../adapters/index.js';
import {
  classifyUrl,
  isPrimary,
  WEBREQUEST_PATTERNS,
  type DetectionKind,
} from '../lib/media-detection.js';
import { filterTopLevel } from '../lib/entry-filter.js';
import { parseManifest } from '../lib/m3u8.js';
import { fetchManifest } from '../lib/manifest-fetch.js';
import { sanitizeFilename } from '../lib/sanitize-filename.js';
import {
  addEntry,
  clearAll,
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
import {
  filenameTemplateFor,
  getSettings,
  hostOf,
  isAdapterEnabled,
  isOriginBlocked,
  renderFilenameTemplate,
} from '../lib/settings.js';
import type {
  DiscoveredStream,
  DownloadState,
  MediaEntry,
  MediaKind,
  PageMeta,
} from '../lib/types.ts';

const BADGE_COLOR = '#ff5d2e';

log.info('SW alive');

chrome.runtime.onInstalled.addListener((details) => {
  log.info('SW installed:', details.reason);
});

// Seed the tab-URL cache so detections that race ahead of webNavigation pick
// up the right pageUrl. Memoized one-shot — handleDetection awaits this so
// the first wave of webRequest events never sees an empty cache.
let seedPromise: Promise<void> | null = null;
function seedTabs(): Promise<void> {
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
// NOTE: `void restoreDownloadState();` is invoked further down in the
// file, after `downloadStates` / `downloadQueue` / the storage keys are
// declared. Calling it here triggers a TDZ ReferenceError that the
// function's try/catch silently swallows, leaving the SW with empty
// state and the popup blank after a worker respawn.

async function restoreDownloadState(): Promise<void> {
  try {
    const got = await chrome.storage.session.get([DOWNLOAD_STATES_KEY, DOWNLOAD_QUEUE_KEY]);
    const persistedStates = got[DOWNLOAD_STATES_KEY];
    if (persistedStates && typeof persistedStates === 'object') {
      for (const [id, state] of Object.entries(persistedStates as Record<string, DownloadState>)) {
        downloadStates.set(id, state);
        // Re-derive activeRequestId from the restored states. There can
        // only be one in-flight slot (queue discipline guarantees it),
        // so if persistence ever serialized two pending/progress states
        // for any reason (writes interleaved with cancel/done) demote
        // the runners-up to 'error' instead of leaving them visible as
        // ghost downloads the offscreen will never report on.
        if (state.status === 'pending' || state.status === 'progress') {
          if (activeRequestId !== null && activeRequestId !== id) {
            log.warn('restored duplicate in-flight download; demoting to error', {
              kept: activeRequestId,
              demoted: id,
            });
            downloadStates.set(id, {
              ...state,
              status: 'error',
              errorCode: 'Error',
              errorMessage: 'Interrupted by extension restart.',
            });
          } else {
            activeRequestId = id;
          }
        }
      }
    }
    const persistedQueue = got[DOWNLOAD_QUEUE_KEY];
    if (Array.isArray(persistedQueue)) {
      downloadQueue.push(...(persistedQueue as RunPayload[]));
    }
    if (downloadStates.size > 0 || downloadQueue.length > 0) {
      log.info('restored download state', {
        states: downloadStates.size,
        queued: downloadQueue.length,
        active: activeRequestId,
      });
    }
  } catch (err) {
    log.warn('restore download state failed', err);
  }
}

// ---------- Tab lifecycle ----------

const isHttpUrl = (u: string | undefined | null): u is string =>
  typeof u === 'string' && /^https?:/.test(u);

/** Best-effort host extraction for the orphan-row section line. */
function hostFromUrl(u: string | undefined | null): string {
  if (!u) return '';
  try {
    return new URL(u).host;
  } catch {
    return '';
  }
}

// Last path segment of a URL, used as the {basename} filename-template
// token (and the default adapter's filename tail).
function basenameFromUrl(u: string): string {
  try {
    const parsed = new URL(u);
    return parsed.pathname.split('/').filter(Boolean).pop() || parsed.host;
  } catch {
    return '';
  }
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // Chrome clears per-tab badge state on every tab navigation —
  // including same-URL refreshes that don't fire the URL branch
  // below. Repaint from current tab state once the load settles so
  // the count survives refresh. No-op when the tab has no entries.
  if (changeInfo.status === 'complete') {
    void updateBadge(tabId);
  }

  // YouTube's SPA navigation between watch pages uses `history.pushState`,
  // and Chrome doesn't always surface that as `changeInfo.url`. The
  // resulting `tabs.onUpdated` event arrives with only e.g. `status` or
  // `title` set — but `tab.url` already reflects the new location. We
  // catch that case by comparing `tab.url` against the cached URL on
  // every fire, regardless of which `changeInfo` field triggered it.
  const nextUrl = changeInfo.url || tab?.url;
  if (!isHttpUrl(nextUrl)) return;
  const { prev } = await setTabUrl(tabId, nextUrl);
  if (prev && prev !== nextUrl) {
    log.info('tab navigated — clearing entries', { tabId, prev, next: nextUrl });
    // NOTE: we intentionally don't clear download states on nav anymore.
    // v0.11.3 makes the popup's "Active downloads" section cross-tab, so
    // a download started on one page must remain visible (and
    // cancellable) after the user navigates away. Stale completed
    // states get GC'd on tab close (onRemoved) + by explicit dismiss.
    const had = await clearTab(tabId);
    if (had) await updateBadge(tabId);
  } else if (prev === nextUrl && changeInfo.title) {
    // Diagnostic — fires on YouTube SPA navs where pushState updated
    // both `tab.url` and `<title>` simultaneously, so by the time we
    // get here the cached URL is already in sync with tab.url and we
    // skip the clear. Useful for spotting "popup didn't refresh on
    // nav" reports: if you see this with prev being a /watch URL and
    // changeInfo.title being a different video's title, the nav was
    // detected but the URL update outran our cache.
    log.debug('tabs.onUpdated: title change, URL already in cache', {
      tabId,
      url: nextUrl,
      title: changeInfo.title,
    });
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  clearDownloadStatesForTab(tabId);
  await removeTab(tabId);
});

// ---------- webRequest observation ----------

chrome.webRequest.onBeforeRequest.addListener(
  (details): undefined => {
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
  (details): undefined => {
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
chrome.runtime.onMessage.addListener((rawMsg, sender, sendResponse) => {
  const msg = parseExtensionMessage(rawMsg);
  if (!msg) return false;
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
    case MSG.STREAMS_DISCOVERED: {
      const tabId = sender.tab?.id;
      const p = msg.payload ?? {};
      if (tabId == null || tabId < 0 || !Array.isArray(p.streams)) {
        sendResponse({ ok: false });
        return false;
      }
      void handleStreamsDiscovered({
        tabId,
        frameId: sender.frameId ?? 0,
        pageUrl: sender.tab?.url || '',
        adapterId: p.adapterId,
        streams: p.streams,
      });
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
      const p = msg.payload;
      if (typeof p.url !== 'string' || typeof p.tabId !== 'number') {
        sendResponse({ ok: false, error: 'missing url/tabId' });
        return false;
      }
      // The guard above narrows `p.tabId` to `number`. Re-spread with
      // the narrowed value so handleProxyFetch's ProxyFetchPayload
      // (which has a required tabId) is happy.
      handleProxyFetch({ ...p, tabId: p.tabId })
        .then(sendResponse)
        .catch((err: unknown) =>
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      return true; // async
    }
    case MSG.DOWNLOAD_PROGRESS: {
      // Offscreen → SW → popup. Update the in-memory state and broadcast.
      handleDownloadProgress(msg.payload);
      sendResponse({ ok: true });
      return false;
    }
    case MSG.DOWNLOAD_DONE: {
      // Offscreen produced a Blob URL; trigger the save AND broadcast.
      handleDownloadDone(msg.payload).catch((err) => log.warn('downloads.download failed', err));
      sendResponse({ ok: true });
      return false;
    }
    case MSG.DOWNLOAD_ERROR: {
      handleDownloadError(msg.payload);
      sendResponse({ ok: true });
      return false;
    }
    case MSG.SHOW_IN_FOLDER: {
      const downloadId = msg.payload?.downloadId;
      if (typeof downloadId === 'number') {
        try {
          chrome.downloads.show(downloadId);
        } catch (err) {
          log.warn('chrome.downloads.show failed', err);
        }
      }
      sendResponse({ ok: true });
      return false;
    }
    case MSG.DISMISS_DOWNLOAD: {
      const mediaId = msg.payload?.mediaId;
      if (typeof mediaId === 'string') dismissDownloadStatesForMedia(mediaId);
      sendResponse({ ok: true });
      return false;
    }
    case MSG.CANCEL_DOWNLOAD: {
      const requestId = msg.payload?.requestId;
      if (typeof requestId === 'string') cancelDownload(requestId);
      sendResponse({ ok: true });
      return false;
    }
    case MSG.RESET_TAB: {
      const tabId = msg.payload?.tabId;
      if (typeof tabId === 'number') {
        // Drop this tab's entries + download states (any status), plus
        // every finished download across all tabs so saved rows in the
        // cross-tab "Active downloads" section clear too. In-progress
        // downloads in OTHER tabs keep running. adapterMeta is preserved
        // by clearTab so the next detection lands with the right title.
        const cleared = clearDownloadStatesForTab(tabId);
        for (const id of clearFinishedDownloadStatesAllTabs()) cleared.add(id);
        broadcastDownloadDismissed(cleared);
        clearTab(tabId)
          .then(async () => {
            await updateBadge(tabId);
            await broadcastTabState(tabId);
            sendResponse({ ok: true });
          })
          .catch((err) => {
            log.warn('RESET_TAB failed', err);
            sendResponse({ ok: false });
          });
        return true; // async sendResponse
      }
      sendResponse({ ok: false });
      return false;
    }
    case MSG.ENSURE_PARSED: {
      // Popup "Loading…" watchdog — re-drive parsing for any unresolved
      // HLS entry. Covers the case where an eager parse was cut off by an
      // MV3 worker teardown while the popup stayed open. ensureParsed is
      // idempotent + in-flight-guarded, so redundant nudges are cheap.
      const tabId = msg.payload?.tabId;
      if (typeof tabId === 'number') {
        getTabState(tabId)
          .then((state) => {
            for (const entry of state.entries) {
              if (entry.kind === 'hls' && !entry.variants && !entry.parseError) {
                void ensureParsed(tabId, entry);
              }
            }
            sendResponse({ ok: true });
          })
          .catch((err) => {
            log.warn('ENSURE_PARSED failed', err);
            sendResponse({ ok: false });
          });
        return true; // async sendResponse
      }
      sendResponse({ ok: false });
      return false;
    }
    case MSG.CLEAR_ALL_CAPTURED: {
      // Options page: forget every tab's detected media + captured meta.
      // Also drop all finished download states so saved rows don't linger.
      for (const id of clearFinishedDownloadStatesAllTabs()) {
        broadcastDownloadDismissed([id]);
      }
      clearAll()
        .then(async (affected) => {
          for (const tabId of affected) {
            await updateBadge(tabId);
            await broadcastTabState(tabId);
          }
          sendResponse({ ok: true });
        })
        .catch((err) => {
          log.warn('CLEAR_ALL_CAPTURED failed', err);
          sendResponse({ ok: false });
        });
      return true; // async sendResponse
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
    // ---------- SW-originated messages echoed back to the SW ----------
    // chrome.runtime.sendMessage delivers to every listener in the
    // extension, including the SW itself. These message types are
    // emitted by the SW for the offscreen (or vice versa) and the SW
    // has no business acting on them — but we list each one explicitly
    // so adding a new MSG.* without a handler is a compile error via
    // assertNever() below.
    case MSG.RUN_DOWNLOAD:
    case MSG.TAB_STATE_UPDATED:
    case MSG.REVOKE_BLOB:
      return false;
    default:
      return assertNever(msg);
  }
});

// ---------- Detection pipeline ----------

interface DetectionInput {
  url: string;
  tabId: number;
  frameId: number;
  kind: DetectionKind;
  headers?: Record<string, string>;
  pageUrl?: string;
  source: string;
}

async function handleDetection({
  url,
  tabId,
  frameId,
  kind,
  headers,
  pageUrl,
  source,
}: DetectionInput): Promise<void> {
  // For v0.2 only primary kinds populate the user-visible list. We still log
  // segment/key observations so dev sanity-checks have something to read.
  if (!isPrimary(kind)) {
    log.debug('observed', { kind, url, source });
    return;
  }
  // isPrimary is a type predicate, so `kind` is already MediaKind here.

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
      log.warn('chrome.tabs.get failed', {
        tabId,
        err: err instanceof Error ? err.message : String(err),
      });
      resolvedPageUrl = '';
    }
  }
  if (resolvedPageUrl) await setTabUrl(tabId, resolvedPageUrl);

  const adapter = pickAdapter(resolvedPageUrl, url);

  // Respect user settings: silence detection on blocked origins and for
  // disabled adapters before anything reaches the popup list.
  const settings = await getSettings();
  if (isOriginBlocked(settings, resolvedPageUrl)) {
    log.debug('detection skipped (origin blocked)', { tabId, host: hostOf(resolvedPageUrl) });
    return;
  }
  if (!isAdapterEnabled(settings, adapter.id)) {
    log.debug('detection skipped (adapter disabled)', { tabId, adapter: adapter.id });
    return;
  }

  // Adapters with discoverStreams (YouTube) are the canonical catalog
  // source for their pages. Passive webRequest captures of their CDN
  // URLs typically duplicate the catalog AND pollute the list with
  // range-fetched chunk URLs that aren't user-pickable (each chunk has
  // a different `range=` query so the URL dedupe doesn't catch them).
  // Skip the entry — the adapter will push the canonical streams via
  // STREAMS_DISCOVERED instead.
  if (typeof adapter.discoverStreams === 'function') {
    log.debug('passive capture suppressed (adapter is canonical)', {
      tabId,
      adapter: adapter.id,
      url,
      source,
    });
    return;
  }

  const entry: Omit<MediaEntry, 'id'> = {
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

interface StreamsDiscoveredInput {
  tabId: number;
  frameId: number;
  pageUrl: string;
  adapterId: string;
  streams: DiscoveredStream[];
}

/**
 * Promote the adapter-supplied catalog of streams into MediaEntries.
 * Mirrors handleDetection — resolve pageUrl, pick adapter, addEntry,
 * dedupe by URL, badge + broadcast. The crucial differences are that
 * variants come pre-populated (no HLS parse step needed) and the
 * `kind` is whatever the adapter declared (typically 'dash' for
 * YouTube's mixed progressive + adaptive catalog).
 */
async function handleStreamsDiscovered({
  tabId,
  frameId,
  pageUrl,
  adapterId,
  streams,
}: StreamsDiscoveredInput): Promise<void> {
  if (streams.length === 0) return;
  await seedTabs();

  let resolvedPageUrl = pageUrl;
  if (!resolvedPageUrl) {
    resolvedPageUrl = await getTabUrl(tabId);
  }
  // Race-window fix (v0.11.6): when the content script's
  // `navigatesuccess` fires for a YouTube SPA-nav, this handler can
  // race ahead of `chrome.tabs.onUpdated`. Without the prev/next
  // compare here, we'd update the URL cache to the new URL and the
  // later onUpdated fire would see prev === nextUrl and skip its
  // clear. The user would see the previous video's entries linger
  // until full refresh — that's the field report. Same compare
  // logic as the tab listener so whichever fires first does the
  // clear correctly.
  if (resolvedPageUrl) {
    const { prev } = await setTabUrl(tabId, resolvedPageUrl);
    if (prev && prev !== resolvedPageUrl) {
      log.info('streams discovered on navigated tab — clearing previous entries', {
        tabId,
        prev,
        next: resolvedPageUrl,
        adapterId,
      });
      await clearTab(tabId);
      await updateBadge(tabId);
    }
  }

  // Respect user settings — silence detection on blocked origins / for
  // disabled adapters, same as the passive webRequest path.
  const settings = await getSettings();
  if (isOriginBlocked(settings, resolvedPageUrl)) {
    log.debug('streams discovered but origin blocked', { tabId, host: hostOf(resolvedPageUrl) });
    return;
  }
  if (!isAdapterEnabled(settings, adapterId)) {
    log.debug('streams discovered but adapter disabled', { tabId, adapter: adapterId });
    return;
  }

  let anyAdded = false;
  let dedupedCount = 0;
  for (const s of streams) {
    if (typeof s.url !== 'string' || !s.url) continue;
    const entry: Omit<MediaEntry, 'id'> = {
      kind: s.kind,
      url: s.url,
      pageUrl: resolvedPageUrl,
      adapterId,
      capturedAt: Date.now(),
      frameId,
      ...(s.headers ? { headers: s.headers } : {}),
      ...(s.totalDuration ? { totalDuration: s.totalDuration } : {}),
      ...(s.drm ? { drm: true } : {}),
      // Adapter-supplied variants are authoritative — no manifest parse
      // step needed. isMaster=true so the popup picker treats them as
      // multi-quality the same way it treats parsed HLS masters.
      ...(s.variants ? { variants: s.variants, isMaster: true } : {}),
      ...(s.audioTracks ? { audioTracks: s.audioTracks } : {}),
      ...(s.discoverySource ? { discoverySource: s.discoverySource } : {}),
    };
    const stored = await addEntry(tabId, entry);
    if (stored) anyAdded = true;
    else dedupedCount += 1;
  }

  if (anyAdded) {
    log.info('streams discovered', {
      tabId,
      adapterId,
      streams: streams.length,
    });
    await updateBadge(tabId);
    await broadcastTabState(tabId);
  } else if (dedupedCount > 0) {
    // Adapter re-discovered the same catalog on a SPA-navigation or
    // re-emission. Useful to see in the log so we can tell the
    // difference between "no streams" and "streams already known".
    log.debug('streams re-discovered (dedupe)', {
      tabId,
      adapterId,
      deduped: dedupedCount,
    });
  }
}

// ---------- Manifest parsing ----------

const inFlightParses = new Set<string>(); // `${tabId}:${mediaId}` while a parse is running

async function ensureParsed(tabId: number, entry: MediaEntry): Promise<void> {
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
      totalDuration: parsed.totalDuration,
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
    const message = err instanceof Error ? err.message : String(err);
    await patchEntry(tabId, entry.id, { parseError: message });
    log.warn('manifest parse failed', { tabId, mediaId: entry.id, err: message });
  } finally {
    inFlightParses.delete(key);
  }
  await broadcastTabState(tabId);
}

// ---------- Download orchestration ----------

const OFFSCREEN_URL = chrome.runtime.getURL('offscreen/offscreen.html');
const OFFSCREEN_IDLE_TEARDOWN_MS = 30_000;
let ensureOffscreenPromise: Promise<void> | null = null;
// Blob URLs the SW handed to chrome.downloads but that haven't been
// revoked yet (chrome.downloads.onChanged hasn't reported complete /
// interrupted). The offscreen mustn't tear down while any of these are
// still backing a download.
const outstandingBlobUrls = new Set<string>();
let idleTeardownTimer: ReturnType<typeof setTimeout> | null = null;

function cancelIdleTeardown(): void {
  if (idleTeardownTimer !== null) {
    clearTimeout(idleTeardownTimer);
    idleTeardownTimer = null;
  }
}

function isOffscreenWorkOutstanding(): boolean {
  if (outstandingBlobUrls.size > 0) return true;
  if (activeRequestId !== null) return true;
  if (downloadQueue.length > 0) return true;
  for (const s of downloadStates.values()) {
    if (s.status === 'pending' || s.status === 'progress' || s.status === 'queued') return true;
  }
  return false;
}

function scheduleIdleTeardown(): void {
  if (isOffscreenWorkOutstanding()) {
    cancelIdleTeardown();
    return;
  }
  if (idleTeardownTimer !== null) return; // already scheduled
  idleTeardownTimer = setTimeout(() => {
    idleTeardownTimer = null;
    // Double-check the world hasn't changed under us between schedule
    // and fire — back-to-back downloads should keep the doc alive.
    if (isOffscreenWorkOutstanding()) return;
    void closeOffscreen();
  }, OFFSCREEN_IDLE_TEARDOWN_MS);
}

async function closeOffscreen(): Promise<void> {
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
    });
    if (!contexts.some((c) => c.documentUrl === OFFSCREEN_URL)) {
      ensureOffscreenPromise = null;
      return;
    }
    await chrome.offscreen.closeDocument();
    log.info('offscreen closed (idle teardown)');
  } catch (err) {
    log.warn('offscreen close failed', err);
  } finally {
    ensureOffscreenPromise = null;
  }
}

async function ensureOffscreen(): Promise<void> {
  // Any new download cancels a pending teardown immediately.
  cancelIdleTeardown();
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

async function handleStartDownload(payload: {
  mediaId: string;
  variantUrl?: string;
  filename?: string;
  audioTrackId?: string;
}): Promise<{ requestId: string; filename: string }> {
  const { mediaId, variantUrl, filename: filenameOverride, audioTrackId } = payload;
  // Find the MediaEntry across all tabs.
  let entry: MediaEntry | null = null;
  let entryTabId: number | null = null;
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
  if (!entry || entryTabId === null) throw new Error(`unknown mediaId: ${mediaId}`);

  // v0.6–v0.10 supported HLS only. v0.11 adds progressive (YouTube
  // itag=18/22) and routes DASH-tagged entries through the adaptive
  // path (also v0.11). The offscreen dispatches on `kind` and throws a
  // typed UnsupportedFormatError for anything still un-implemented.

  const adapter = getAdapter(entry.adapterId);
  const meta = entry.meta ?? {};
  // Honor a user-supplied filename from the popup row's input if it
  // resolves to something non-empty post-sanitize; otherwise the adapter
  // derives one from the page meta + URL.
  let baseName: string;
  if (filenameOverride && filenameOverride.trim().length > 0) {
    baseName = filenameOverride;
  } else {
    // Try the user's per-adapter filename template first; an empty render
    // (all tokens missing) falls back to the adapter's own deriveFilename.
    const settings = await getSettings();
    const templated = renderFilenameTemplate(filenameTemplateFor(settings, adapter.id), {
      title: meta.title || meta.ogTitle || meta.ogVideoTitle || undefined,
      lesson: meta.lessonTitle,
      section: meta.sectionTitle,
      channel: meta.channelTitle,
      basename: basenameFromUrl(entry.url),
      videoId: meta.videoId,
    });
    baseName =
      templated ||
      adapter.deriveFilename({
        pageMeta: meta,
        url: entry.url,
        mediaEntry: entry,
      });
  }
  const filename = sanitizeFilename(baseName, { fallback: 'video' });

  const requestId = crypto.randomUUID();
  const finalVariantUrl = variantUrl && /^https?:/.test(variantUrl) ? variantUrl : entry.url;

  // Determine the dispatch kind from the picked variant, not the entry.
  // YouTube's catalog entry is tagged 'dash' overall (adaptive is the
  // modern norm) but variants[] mixes progressive itags (18/22/36) with
  // adaptive ones — picking 360p must route to the progressive
  // downloader, picking 1080p must route to the adaptive path.
  // classifyUrl reads itag/mime/ext and returns the right kind for
  // googlevideo URLs; HLS variants fall through to entry.kind because
  // every HLS variant URL inherits the master's media type.
  const variantKind = classifyUrl(finalVariantUrl);
  const downloadKind: MediaKind = isPrimary(variantKind) ? variantKind : entry.kind;

  // Look the picked variant up by url so we can carry pairedAudio*
  // forward — the popup only sends variantUrl, but the adaptive
  // downloader (v0.11.1) needs the audio sibling URL the YouTube
  // adapter attached. No-op for HLS / progressive variants where
  // pairedAudioUrl is unset.
  const pickedVariant = entry.variants?.find((v) => v.url === finalVariantUrl);

  // Audio-track override (YouTube multi-dub videos). When the popup
  // sends `audioTrackId`, resolve it against the entry's audioTracks
  // catalog and substitute that track's URL / contentLength / cipher
  // for the variant's default paired audio. Falls back silently to
  // the variant default when the id doesn't resolve (stale popup
  // state after a re-discovery, etc.) — keeps the download moving.
  let resolvedPairedAudioUrl = pickedVariant?.pairedAudioUrl;
  let resolvedPairedAudioContentLength = pickedVariant?.pairedAudioContentLength;
  let resolvedPairedSignatureCipher = pickedVariant?.pairedSignatureCipher;
  let resolvedAudioTrackId: string | undefined;
  if (audioTrackId && entry.audioTracks) {
    const at = entry.audioTracks.find((t) => t.id === audioTrackId);
    if (at) {
      resolvedPairedAudioUrl = at.url;
      resolvedPairedAudioContentLength = at.contentLength;
      resolvedPairedSignatureCipher = at.signatureCipher;
      resolvedAudioTrackId = at.id;
    }
  }

  const runPayload: RunPayload = {
    requestId,
    kind: downloadKind,
    variantUrl: finalVariantUrl,
    tabId: entryTabId,
    frameId: entry.frameId ?? 0,
    headers: entry.headers,
    filename,
    ...(resolvedPairedAudioUrl ? { pairedAudioUrl: resolvedPairedAudioUrl } : {}),
    ...(resolvedPairedAudioContentLength
      ? { pairedAudioContentLength: resolvedPairedAudioContentLength }
      : {}),
    // signatureCipher blobs (v0.11.1): when the variant came from
    // YouTube's adaptiveFormats and the URL was gated behind
    // signatureCipher, forward the encoded triple so the offscreen
    // can re-decipher the signature before fetching. Skipped for
    // variants whose `url` is already directly fetchable.
    ...(pickedVariant?.contentLength ? { variantContentLength: pickedVariant.contentLength } : {}),
    ...(pickedVariant?.signatureCipher ? { signatureCipher: pickedVariant.signatureCipher } : {}),
    ...(resolvedPairedSignatureCipher
      ? { pairedSignatureCipher: resolvedPairedSignatureCipher }
      : {}),
    ...(resolvedAudioTrackId ? { audioTrackId: resolvedAudioTrackId } : {}),
    ...(entry.discoverySource ? { discoverySource: entry.discoverySource } : {}),
  };

  // Slim snapshot of the parent entry + picked variant for the popup's
  // cross-tab "Active downloads" rows. Lets an orphan row (a download
  // whose source-tab entry isn't in this popup's view) still show
  // title / size / duration / codec — same shape as an inline row.
  // See DownloadState.entrySnapshot.
  const variantBytes =
    pickedVariant?.contentLength && pickedVariant.contentLength > 0
      ? pickedVariant.contentLength
      : undefined;
  const pairedBytes =
    resolvedPairedAudioContentLength && resolvedPairedAudioContentLength > 0
      ? resolvedPairedAudioContentLength
      : undefined;
  const entrySnapshot = {
    title: meta.lessonTitle || meta.title || meta.ogTitle || meta.ogVideoTitle || undefined,
    section: meta.sectionTitle || meta.ogSiteName || hostFromUrl(entry.pageUrl) || undefined,
    kind: downloadKind,
    adapterId: entry.adapterId,
    ...(entry.totalDuration ? { totalDuration: entry.totalDuration } : {}),
    ...(variantBytes ? { variantContentLength: variantBytes } : {}),
    ...(pickedVariant?.resolution ? { variantResolution: pickedVariant.resolution } : {}),
    ...(pickedVariant?.codecs ? { variantCodecs: pickedVariant.codecs } : {}),
    ...(pickedVariant?.bandwidth ? { variantBandwidth: pickedVariant.bandwidth } : {}),
    ...(pairedBytes ? { pairedAudioContentLength: pairedBytes } : {}),
  };

  // Seed the per-request state BEFORE forwarding to the offscreen, so the
  // first DOWNLOAD_PROGRESS message can patch it instead of creating a
  // race-window where the popup sees progress but no row state.
  downloadStates.set(requestId, {
    requestId,
    mediaId,
    tabId: entryTabId,
    filename: `${filename}.mp4`,
    // Picked variant URL so the popup can keep the size/duration badges
    // pinned to the right variant after the dropdown is replaced by the
    // in-progress UI.
    variantUrl: finalVariantUrl,
    ...(resolvedAudioTrackId ? { audioTrackId: resolvedAudioTrackId } : {}),
    entrySnapshot,
    status: 'pending',
    stage: null,
    current: 0,
    total: 0,
    segmentCurrent: 0,
    segmentTotal: 0,
    startedAt: Date.now(),
  });
  broadcastDownloadState(downloadStates.get(requestId));

  await ensureOffscreen();
  enqueueOrStart(runPayload);

  log.info('download started', {
    requestId,
    mediaId,
    tabId: entryTabId,
    frameId: entry.frameId ?? 0,
    adapter: entry.adapterId,
    filename: `${filename}.mp4`,
    kind: downloadKind,
    queued: activeRequestId !== requestId,
  });
  return { requestId, filename: `${filename}.mp4` };
}

// ---------- download queue ----------
//
// Serialize downloads: only one RUN_DOWNLOAD lives in the offscreen at
// a time. Subsequent START_DOWNLOAD requests are seeded in the SW state
// with status 'queued' (popup shows a "Queued" pill) and start when the
// active one reaches a terminal state.
//
// In-memory only; on SW restart the offscreen-running download is lost
// regardless. The queue carries the verbatim RUN_DOWNLOAD payload so
// advancement is a one-line resend.

interface RunPayload {
  requestId: string;
  kind: MediaEntry['kind'];
  variantUrl: string;
  tabId: number;
  frameId: number;
  headers?: Record<string, string>;
  filename: string;
  pairedAudioUrl?: string;
  pairedAudioContentLength?: number;
  signatureCipher?: string;
  pairedSignatureCipher?: string;
  /** Resolved audio track id (logging / state visibility only). */
  audioTrackId?: string;
}

let activeRequestId: string | null = null;
const downloadQueue: RunPayload[] = [];

function enqueueOrStart(run: RunPayload): void {
  if (activeRequestId === null) {
    activeRequestId = run.requestId;
    runInOffscreen(run);
    return;
  }
  // Someone's already downloading. Park this one behind them.
  setDownloadState(run.requestId, { status: 'queued' });
  downloadQueue.push(run);
  void persistDownloadQueue();
}

function runInOffscreen(run: RunPayload): void {
  // SW → offscreen uses RUN_DOWNLOAD so it doesn't collide with the
  // popup→SW START_DOWNLOAD message on the broadcast bus.
  void chrome.runtime
    .sendMessage({ type: MSG.RUN_DOWNLOAD, payload: run })
    .catch((err) => log.warn('forward RUN_DOWNLOAD to offscreen failed', err));
}

// Called when the active download reaches a terminal status (saved /
// error / canceled). Clears the active slot and starts the next queued
// run, if any.
function advanceQueue(finishedRequestId: string): void {
  if (activeRequestId !== finishedRequestId) return;
  activeRequestId = null;
  const next = downloadQueue.shift();
  if (!next) {
    void persistDownloadQueue();
    return;
  }
  activeRequestId = next.requestId;
  // Promote 'queued' → 'pending' so the popup row repaints with the
  // initial progress UI before the offscreen's first DOWNLOAD_PROGRESS
  // lands.
  setDownloadState(next.requestId, {
    status: 'pending',
    stage: null,
    current: 0,
    total: 0,
    segmentCurrent: 0,
    segmentTotal: 0,
  });
  runInOffscreen(next);
  void persistDownloadQueue();
}

interface ProxyFetchPayload {
  tabId: number;
  frameId?: number;
  url: string;
  headers?: Record<string, string>;
  responseType: 'text' | 'arrayBuffer';
}

async function handleProxyFetch({
  tabId,
  frameId,
  url,
  headers,
  responseType,
}: ProxyFetchPayload): Promise<unknown> {
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
    return {
      ok: false,
      error: `proxy unreachable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ---------- download-state machine ----------
//
// One DownloadState per `requestId`:
//   { requestId, mediaId, tabId, filename,
//     status: 'pending'|'progress'|'saved'|'error',
//     stage, current, total,          // progress fields
//     downloadId,                      // saved
//     errorCode, errorMessage }        // error
//
// Created when handleStartDownload accepts the request, updated on
// every offscreen → SW progress / done / error message, then pushed to
// any popup ports subscribed to the matching tab. Mirrored to
// chrome.storage.session (in-memory but survives SW restart) so a
// killed worker can resume reporting state without losing in-flight
// download UI. The offscreen document outlives the SW, so its
// DOWNLOAD_PROGRESS messages land on the new SW and patch the
// restored state normally.
const downloadStates = new Map<string, DownloadState>();

// Final states. Once a download reaches one, late messages from the
// offscreen document must not move it back to a live state.
const TERMINAL_STATUSES: ReadonlySet<DownloadState['status']> = new Set([
  'saved',
  'error',
  'canceled',
]);

function isTerminalStatus(status: DownloadState['status']): boolean {
  return TERMINAL_STATUSES.has(status);
}

const DOWNLOAD_STATES_KEY = 'downloadStates';
const DOWNLOAD_QUEUE_KEY = 'downloadQueue';

// Has to live AFTER downloadStates / downloadQueue / the storage keys
// are declared; otherwise the function body's first synchronous tick
// hits TDZ on those identifiers and the try/catch turns it into a
// silent no-op. See the comment near `seedTabs();`.
void restoreDownloadState();

async function persistDownloadStates(): Promise<void> {
  try {
    const states: Record<string, DownloadState> = {};
    for (const [id, s] of downloadStates) states[id] = s;
    await chrome.storage.session.set({ [DOWNLOAD_STATES_KEY]: states });
  } catch {
    // session storage momentarily unavailable; the next state change
    // will retry.
  }
}

async function persistDownloadQueue(): Promise<void> {
  try {
    await chrome.storage.session.set({ [DOWNLOAD_QUEUE_KEY]: downloadQueue });
  } catch {
    // see persistDownloadStates
  }
}

function setDownloadState(requestId: string, patch: Partial<DownloadState>): DownloadState | null {
  const prev = downloadStates.get(requestId);
  if (!prev) return null;
  const next: DownloadState = { ...prev, ...patch, updatedAt: Date.now() };
  downloadStates.set(requestId, next);
  broadcastDownloadState(next);
  void persistDownloadStates();
  return next;
}

function broadcastDownloadState(state: DownloadState | null | undefined): void {
  if (!state || popupPorts.size === 0) return;
  // v0.11.3: downloads are cross-tab now. Every subscribed popup
  // gets every state update, regardless of which tab it lives on.
  // The popup renders an always-visible "Active downloads" section
  // populated from the union; tab-scoped media entries stay separate.
  for (const [port] of popupPorts) {
    try {
      port.postMessage({ type: 'DOWNLOAD_STATE', state });
    } catch {
      // disconnected mid-send; onDisconnect cleans up
    }
  }
}

function handleDownloadProgress(payload: unknown): void {
  if (!payload || typeof payload !== 'object') return;
  const p = payload as {
    requestId?: unknown;
    stage?: unknown;
    current?: unknown;
    total?: unknown;
    segmentCurrent?: unknown;
    segmentTotal?: unknown;
  };
  if (typeof p.requestId !== 'string') return;
  // Cancelling doesn't stop the chunk already in flight, so the
  // offscreen emits a few more progress ticks after the state is
  // already final. Applying them repaints the progress bar over the
  // "Canceled" row — the flicker — and worse, it moves the status off
  // 'canceled', so the guard in handleDownloadError no longer matches
  // and the row settles on "error" for a download the user cancelled
  // deliberately.
  const existing = downloadStates.get(p.requestId);
  if (existing && isTerminalStatus(existing.status)) return;
  setDownloadState(p.requestId, {
    status: 'progress',
    stage: p.stage as DownloadState['stage'],
    current: Number(p.current),
    total: Number(p.total),
    segmentCurrent: typeof p.segmentCurrent === 'number' ? p.segmentCurrent : undefined,
    segmentTotal: typeof p.segmentTotal === 'number' ? p.segmentTotal : undefined,
  });
}

function handleDownloadError(payload: unknown): void {
  if (!payload || typeof payload !== 'object') return;
  const p = payload as { requestId?: unknown; code?: unknown; message?: unknown };
  if (typeof p.requestId !== 'string') return;
  const existing = downloadStates.get(p.requestId);
  // 'canceled' is the user-initiated final state set synchronously by
  // cancelDownload(). The DOWNLOAD_ERROR arriving from the offscreen
  // here — even with code='Canceled' — must NOT overwrite it with
  // 'error'. But we DO still drive the lifecycle forward: advance the
  // queue (the offscreen has now unwound, so the next queued request
  // can start) and re-arm the idle teardown.
  if (existing?.status === 'canceled') {
    clearPendingCancelTimeout(p.requestId);
    advanceQueue(p.requestId);
    scheduleIdleTeardown();
    return;
  }
  log.warn('download error', { requestId: p.requestId, code: p.code, message: p.message });
  setDownloadState(p.requestId, {
    status: 'error',
    errorCode: typeof p.code === 'string' ? p.code : 'Error',
    errorMessage: typeof p.message === 'string' ? p.message : '',
  });
  advanceQueue(p.requestId);
  scheduleIdleTeardown();
}

// Mark the SW state 'canceled' synchronously (so the popup's row flips
// instantly) and either forward the cancel to the offscreen (if the
// request was active) or drop it from the queue (if it hadn't started
// yet). Idempotent on already-final states.
function cancelDownload(requestId: string): void {
  const state = downloadStates.get(requestId);
  if (!state) return;
  if (state.status === 'saved' || state.status === 'error' || state.status === 'canceled') {
    return;
  }
  // Queued request: just remove it from the queue. The offscreen never
  // started it, so there's nothing to abort.
  if (state.status === 'queued') {
    const idx = downloadQueue.findIndex((r) => r.requestId === requestId);
    if (idx !== -1) {
      downloadQueue.splice(idx, 1);
      void persistDownloadQueue();
    }
    setDownloadState(requestId, {
      status: 'canceled',
      errorCode: 'Canceled',
      errorMessage: 'canceled by user',
    });
    scheduleIdleTeardown();
    return;
  }
  // Active (pending / progress) request: transition + tell the offscreen.
  setDownloadState(requestId, {
    status: 'canceled',
    errorCode: 'Canceled',
    errorMessage: 'canceled by user',
  });
  chrome.runtime.sendMessage({ type: MSG.CANCEL_DOWNLOAD, payload: { requestId } }).catch(() => {
    // offscreen may be down; nothing to abort.
  });
  // Do NOT advance the queue yet. The offscreen still has the in-flight
  // download unwinding (fetches in-flight may take a few seconds to
  // throw, remux loop may be mid-segment). Advancing now would start
  // the next queued download in parallel, violating the
  // one-download-at-a-time invariant the queue exists to enforce. Let
  // handleDownloadError drive the advance when the offscreen confirms.
  // Safety net: if the offscreen never confirms (crashed, killed),
  // force-advance after 10s so the queue doesn't stick forever.
  schedulePendingCancelTimeout(requestId);
}

// Maps requestId → safety-timeout timer ID, set when cancelDownload
// sends the abort and cleared when handleDownloadError confirms.
const pendingCancelTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
const CANCEL_CONFIRMATION_TIMEOUT_MS = 10_000;

function schedulePendingCancelTimeout(requestId: string): void {
  clearPendingCancelTimeout(requestId);
  const timer = setTimeout(() => {
    pendingCancelTimeouts.delete(requestId);
    // Offscreen hasn't confirmed the cancel within the window — assume
    // it's gone and unblock the queue.
    log.warn('cancel confirmation timeout; force-advancing queue', { requestId });
    advanceQueue(requestId);
    scheduleIdleTeardown();
  }, CANCEL_CONFIRMATION_TIMEOUT_MS);
  pendingCancelTimeouts.set(requestId, timer);
}

function clearPendingCancelTimeout(requestId: string): void {
  const timer = pendingCancelTimeouts.get(requestId);
  if (timer !== undefined) {
    clearTimeout(timer);
    pendingCancelTimeouts.delete(requestId);
  }
}

async function handleDownloadDone(payload: unknown): Promise<void> {
  if (!payload || typeof payload !== 'object') return;
  const p = payload as {
    blobUrl?: unknown;
    requestId?: unknown;
    filename?: unknown;
    bytes?: unknown;
    segments?: unknown;
  };
  if (typeof p.blobUrl !== 'string' || typeof p.filename !== 'string') return;
  const blobUrl = p.blobUrl;
  const filename = p.filename;
  const requestId = typeof p.requestId === 'string' ? p.requestId : null;
  // The user may have canceled between the offscreen producing the
  // blob and this DOWNLOAD_DONE landing (remux can take several
  // seconds; cancel mid-remux still aborts via the signal but a cancel
  // very late in the loop can race past the throwIfAborted check).
  // Don't save in that case — revoke the blob the offscreen created,
  // drive the lifecycle forward, and bail.
  if (requestId) {
    const existing = downloadStates.get(requestId);
    if (existing?.status === 'canceled') {
      log.info('suppressed save for canceled request', { requestId });
      chrome.runtime.sendMessage({ type: MSG.REVOKE_BLOB, payload: { blobUrl } }).catch(() => {});
      clearPendingCancelTimeout(requestId);
      advanceQueue(requestId);
      scheduleIdleTeardown();
      return;
    }
  }
  const downloadId = await chrome.downloads.download({
    url: blobUrl,
    filename,
    saveAs: false,
  });
  log.info('chrome.downloads accepted', {
    downloadId,
    filename,
    bytes: p.bytes,
    segments: p.segments,
  });
  if (requestId) {
    setDownloadState(requestId, {
      status: 'saved',
      downloadId,
      filename,
      bytes: typeof p.bytes === 'number' ? p.bytes : 0,
    });
    advanceQueue(requestId);
  }
  // Block the idle-teardown timer until chrome.downloads.onChanged
  // tells us this blob has actually been read off the offscreen
  // document. Closing offscreen earlier would invalidate the blob URL
  // mid-save.
  outstandingBlobUrls.add(blobUrl);
  // Revoke the offscreen Blob URL once the download lands or is interrupted.
  // The offscreen document stays alive across downloads, so without this
  // each Blob URL would pin its underlying buffer in memory forever.
  const listener = (delta: chrome.downloads.DownloadDelta): void => {
    if (delta.id !== downloadId) return;
    if (delta.state?.current === 'complete' || delta.state?.current === 'interrupted') {
      chrome.downloads.onChanged.removeListener(listener);
      chrome.runtime.sendMessage({ type: MSG.REVOKE_BLOB, payload: { blobUrl } }).catch(() => {
        // Offscreen may have closed; nothing to revoke.
      });
      outstandingBlobUrls.delete(blobUrl);
      scheduleIdleTeardown();
    }
  };
  chrome.downloads.onChanged.addListener(listener);
}

// Drop every download state for this tab (any status) plus its queued
// runs. Returns the set of affected mediaIds so the caller can tell open
// popups to drop the matching rows.
function clearDownloadStatesForTab(tabId: number): Set<string> {
  const clearedMediaIds = new Set<string>();
  let stateMutated = false;
  for (const [requestId, state] of downloadStates) {
    if (state.tabId === tabId) {
      clearedMediaIds.add(state.mediaId);
      downloadStates.delete(requestId);
      stateMutated = true;
    }
  }
  // Also drop any queued runs for this tab so they don't fire later;
  // their state entries are already gone above.
  let queueMutated = false;
  for (let i = downloadQueue.length - 1; i >= 0; i -= 1) {
    if (downloadQueue[i].tabId === tabId) {
      downloadQueue.splice(i, 1);
      queueMutated = true;
    }
  }
  if (stateMutated) void persistDownloadStates();
  if (queueMutated) void persistDownloadQueue();
  return clearedMediaIds;
}

// Drop finished (saved / error / canceled) download states across ALL
// tabs. Used by Reset so the cross-tab "Active downloads" section is
// wiped of completed rows; in-progress / queued downloads in other tabs
// are left running. Returns the affected mediaIds.
function clearFinishedDownloadStatesAllTabs(): Set<string> {
  const clearedMediaIds = new Set<string>();
  let mutated = false;
  for (const [requestId, state] of downloadStates) {
    if (state.status === 'saved' || state.status === 'error' || state.status === 'canceled') {
      clearedMediaIds.add(state.mediaId);
      downloadStates.delete(requestId);
      mutated = true;
    }
  }
  if (mutated) void persistDownloadStates();
  return clearedMediaIds;
}

// Tell every open popup to drop the given mediaIds from its local
// download cache (clears both inline rows and the cross-tab "Active
// downloads" orphan rows). Unlike dismissDownloadStatesForMedia's
// per-tab notify, this fans out to all ports because orphan rows render
// regardless of which tab they originated from.
function broadcastDownloadDismissed(mediaIds: Iterable<string>): void {
  for (const mediaId of mediaIds) {
    for (const [port] of popupPorts) {
      try {
        port.postMessage({ type: 'DOWNLOAD_DISMISSED', mediaId });
      } catch {
        // disconnected; onDisconnect cleans up
      }
    }
  }
}

// Drop any cached DownloadState for this mediaId across all tabs and
// notify subscribed popups so the row reverts to its Download + quality-
// picker UI. Wired to the "Download again" / "Try again" buttons.
function dismissDownloadStatesForMedia(mediaId: string): void {
  const dismissedTabIds = new Set<number>();
  let stateMutated = false;
  for (const [requestId, state] of downloadStates) {
    if (state.mediaId === mediaId) {
      downloadStates.delete(requestId);
      dismissedTabIds.add(state.tabId);
      stateMutated = true;
    }
  }
  // If a queued run for this mediaId hasn't started yet, drop it too —
  // otherwise the dismiss would clear the visible state while the run
  // fires later and re-creates a new entry. Also evict orphaned queue
  // entries whose state was already wiped (e.g. by clearDownloadStatesForTab)
  // — those are unrecoverable noise and we don't want enqueueOrStart to
  // ever advance to them.
  let queueMutated = false;
  for (let i = downloadQueue.length - 1; i >= 0; i -= 1) {
    const run = downloadQueue[i];
    const state = downloadStates.get(run.requestId);
    const isOrphan = !state;
    const matchesDismissedMedia = state?.mediaId === mediaId;
    if (isOrphan || matchesDismissedMedia) {
      downloadQueue.splice(i, 1);
      queueMutated = true;
    }
  }
  if (stateMutated) void persistDownloadStates();
  if (queueMutated) void persistDownloadQueue();
  if (dismissedTabIds.size === 0) return;
  for (const [port, info] of popupPorts) {
    if (info.tabId !== null && dismissedTabIds.has(info.tabId)) {
      try {
        port.postMessage({ type: 'DOWNLOAD_DISMISSED', mediaId });
      } catch {
        // disconnected; onDisconnect cleans up
      }
    }
  }
}

// Helper: enumerate tabIds currently subscribed via popup ports. Cheap
// fast-path for handleStartDownload (the popup is the only context that
// can call START_DOWNLOAD, so the active tab is almost always covered).
function popupPortsTabs(): Set<number> {
  const out = new Set<number>();
  for (const info of popupPorts.values()) {
    if (typeof info.tabId === 'number') out.add(info.tabId);
  }
  return out;
}

async function listTrackedTabs(): Promise<number[]> {
  // chrome.storage.session has the mediaState dump; mining keys is cheaper
  // than maintaining a parallel index for v0.6.
  try {
    const got = await chrome.storage.session.get('mediaState');
    return got.mediaState ? Object.keys(got.mediaState).map(Number) : [];
  } catch {
    return [];
  }
}

async function entryIsResolved(tabId: number, mediaId: string): Promise<boolean> {
  const state = await getTabState(tabId);
  const fresh = state.entries.find((e) => e.id === mediaId);
  return !!(fresh && fresh.variants);
}

async function handleManifestBody(tabId: number, url: string, text: string): Promise<void> {
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
      totalDuration: parsed.totalDuration,
      parseError: undefined,
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
    const message = err instanceof Error ? err.message : String(err);
    log.warn('parse from body failed', { tabId, mediaId: entry.id, err: message });
    // Don't set parseError — the SW fallback fetch may still succeed.
  }
}

async function updateBadge(tabId: number): Promise<void> {
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

async function handlePageMeta(tabId: number, adapterId: string, meta: PageMeta): Promise<void> {
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
      // Replay every in-flight + recently-completed download state to
      // the popup so the "Active downloads" section is populated
      // immediately on open, regardless of which tab the download
      // originated from. v0.11.3 dropped the per-tab filter here for
      // the same reason as in broadcastDownloadState.
      for (const [, ds] of downloadStates) {
        try {
          port.postMessage({ type: 'DOWNLOAD_STATE', state: ds });
        } catch {
          // disconnected; onDisconnect will clean up
        }
      }
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

async function broadcastTabState(tabId: number): Promise<void> {
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
