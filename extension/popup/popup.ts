import { escapeHtml } from '../lib/dom-utils.js';
import { filterTopLevel } from '../lib/entry-filter.js';
import { log, redactUrl } from '../lib/log.js';
import { MSG, parsePortMessageFromSW } from '../lib/messages.js';
import { sanitizeFilename } from '../lib/sanitize-filename.js';
import type { DownloadStage, DownloadState, HlsVariant, MediaEntry } from '../lib/types.ts';

const $content = document.getElementById('content')!;
const $gear = document.getElementById('open-options');
const $reset = document.getElementById('reset-tab');

$gear?.addEventListener('click', () => chrome.runtime.openOptionsPage?.());

// Reset clears the SW-side tab state for the active tab. The SW pushes
// the resulting empty STATE through the popup port, so the row list
// blanks out and the badge clears. PageMeta is preserved on the SW
// side, so any newly-detected videos still get titled correctly.
$reset?.addEventListener('click', async () => {
  const tabId = await activeTabId();
  if (tabId == null) return;
  try {
    await chrome.runtime.sendMessage({ type: MSG.RESET_TAB, payload: { tabId } });
  } catch (err) {
    log.warn('[VDL] reset failed', err);
  }
});

// ---------- helpers ----------

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function basenameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname.split('/').filter(Boolean).pop() || u.host;
  } catch {
    return url;
  }
}

const KIND_LABELS: Record<string, string> = {
  hls: 'HLS',
  dash: 'DASH',
  progressive: 'MP4/WebM',
};

function entryTitle(entry: MediaEntry): string {
  const m = entry.meta ?? {};
  return m.lessonTitle || m.title || m.ogTitle || m.ogVideoTitle || basenameFromUrl(entry.url);
}

function entrySection(entry: MediaEntry): string {
  const m = entry.meta ?? {};
  return m.sectionTitle || m.ogSiteName || safeHost(entry.pageUrl) || safeHost(entry.url);
}

function entryFilename(entry: MediaEntry): string {
  // Default the filename input to the same title chain the row-title
  // displays — lessonTitle / title / OG title — sanitized so what the
  // user sees matches what the SW will save. URL basename is the last
  // resort (e.g. master-pkg-t-1746628520000) and is rarely useful.
  const m = entry.meta ?? {};
  const raw =
    m.lessonTitle ||
    m.title ||
    m.ogTitle ||
    m.ogVideoTitle ||
    m.filenameHint ||
    basenameFromUrl(entry.url);
  return sanitizeFilename(raw, { fallback: 'video' });
}

function entryBadges(entry: MediaEntry): string[] {
  const out: string[] = [];
  const kind = KIND_LABELS[entry.kind] || entry.kind;
  if (kind) out.push(kind);
  if (entry.parseError) out.push('manifest unavailable');
  return out;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const kib = bytes / 1024;
  if (kib < 1024) return `${Math.round(kib)} KB`;
  const mib = kib / 1024;
  if (mib < 1024) return `${mib.toFixed(mib < 10 ? 1 : 0)} MB`;
  const gib = mib / 1024;
  return `${gib.toFixed(gib < 10 ? 2 : 1)} GB`;
}

// For master entries the duration lives on the matching variant entry
// (the master playlist doesn't carry per-variant durations). For media
// playlists it's on the entry itself.
function resolveDurationSeconds(entry: MediaEntry, variantUrl: string | undefined): number {
  if (entry.totalDuration && entry.totalDuration > 0) return entry.totalDuration;
  if (variantUrl) {
    for (const e of entriesById.values()) {
      if (e.url === variantUrl && e.totalDuration && e.totalDuration > 0) {
        return e.totalDuration;
      }
    }
  }
  // Last resort: duration is identical across HLS variants of the same
  // content (alternate encodings of the same video), so any sibling
  // variant's parsed duration is a valid fallback. Without this, the
  // size estimate blanks out as soon as the user picks a quality the
  // browser hasn't played — only the currently-playing variant's media
  // playlist gets fetched, so 240p / 360p stay duration-less until the
  // user actually downloads them.
  if (Array.isArray(entry.variants)) {
    for (const v of entry.variants) {
      for (const e of entriesById.values()) {
        if (e.url === v.url && e.totalDuration && e.totalDuration > 0) {
          return e.totalDuration;
        }
      }
    }
  }
  return 0;
}

// Resolve estimated (or exact) byte size for the chosen variant.
// Priority:
//   1. Variant's declared `contentLength` (YouTube publishes this).
//   2. BANDWIDTH × duration / 8 (HLS — master declares bandwidth, media
//      playlist has duration).
// Returns 0 when neither path resolves; the popup hides the badge.
function resolveSizeBytes(entry: MediaEntry, variantUrl: string | undefined): number {
  if (variantUrl && Array.isArray(entry.variants)) {
    const v = entry.variants.find((x) => x.url === variantUrl);
    if (v?.contentLength && v.contentLength > 0) return v.contentLength;
    const dur = resolveDurationSeconds(entry, variantUrl);
    if (dur > 0 && v && v.bandwidth > 0) return Math.round((v.bandwidth * dur) / 8);
  }
  return 0;
}

function formatVariant(v: HlsVariant): string {
  const resPart = v.resolution?.includes('x')
    ? `${v.resolution.split('x')[1]}p`
    : v.resolution || '';
  const bwPart = v.bandwidth ? `${Math.round(v.bandwidth / 1000)} kbps` : '';
  if (resPart && bwPart) return `${resPart} (${bwPart})`;
  return resPart || bwPart || 'variant';
}

function qualityOptionsHtml(entry: MediaEntry): string {
  if (entry.parseError) {
    return '<option value="auto">Manifest unavailable</option>';
  }
  if (Array.isArray(entry.variants) && entry.variants.length > 0) {
    return entry.variants
      .map((v) => `<option value="${escapeHtml(v.url)}">${escapeHtml(formatVariant(v))}</option>`)
      .join('');
  }
  if (entry.isMaster === false) {
    return '<option value="single">Single quality</option>';
  }
  return '<option value="auto">Loading…</option>';
}

// filterTopLevel lives in lib/entry-filter.js — the SW shares it for the
// badge count so the two never disagree on what's "user-visible".

// ---------- render ----------

function renderEmpty() {
  return `
    <div class="empty">
      <p class="empty-title">No videos detected on this tab.</p>
      <p class="empty-hint">Press play on a video for ~2&nbsp;seconds, then reopen this popup.</p>
    </div>
  `;
}

// Friendly error messages for each typed error from lib/errors.js. The
// SW forwards err.name (e.g. "TokenExpiredError") as `errorCode`; the
// popup maps it here so future error types only need one tweak.
const ERROR_MESSAGES: Record<string, string> = {
  TokenExpiredError: 'Token expired. Reload the page and try again.',
  ManifestParseError: "Couldn't read the video manifest.",
  DecryptionError: 'Decryption failed. Try reloading the page.',
  RemuxError: "Couldn't repackage the video.",
  DRMProtectedError: "This stream is DRM-protected and can't be downloaded.",
  UnsupportedFormatError: 'Unsupported stream format.',
};

function friendlyErrorMessage(state: DownloadState): string {
  return (
    (state.errorCode && ERROR_MESSAGES[state.errorCode]) ||
    state.errorMessage ||
    'Download failed. Check the console for details.'
  );
}

function stageLabel(stage: DownloadStage): string {
  switch (stage) {
    case 'fetch':
      return 'fetching';
    case 'decrypt':
      return 'decrypting';
    case 'remux':
      return 'remuxing';
    default:
      return 'preparing';
  }
}

function renderActionForDownload(state: DownloadState): string {
  if (state.status === 'saved') {
    return `
      <div class="download-result saved">
        <span class="saved-pill">Saved &#x2713;</span>
        <button type="button" class="show-in-folder" data-download-id="${state.downloadId}">
          Show in folder
        </button>
        <button type="button" class="dismiss-download" data-media-id="${escapeHtml(state.mediaId)}" title="Download again">
          &#x21bb; Again
        </button>
      </div>`;
  }
  if (state.status === 'error') {
    return `
      <div class="download-result error" title="${escapeHtml(state.errorMessage || '')}">
        <span class="error-label">${escapeHtml(friendlyErrorMessage(state))}</span>
        <button type="button" class="dismiss-download" data-media-id="${escapeHtml(state.mediaId)}" title="Try again">
          &#x21bb; Retry
        </button>
      </div>`;
  }
  if (state.status === 'canceled') {
    return `
      <div class="download-result canceled">
        <span class="canceled-pill">Canceled</span>
        <button type="button" class="dismiss-download" data-media-id="${escapeHtml(state.mediaId)}" title="Start over">
          &#x21bb; Again
        </button>
      </div>`;
  }
  if (state.status === 'queued') {
    return `
      <div class="download-result queued">
        <span class="queued-pill">Queued</span>
        <span class="queued-hint">waiting for an earlier download</span>
        <button type="button" class="cancel-download" data-request-id="${escapeHtml(state.requestId)}" title="Cancel">
          &#x2715;
        </button>
      </div>`;
  }
  // pending / progress. `current/total` is now weighted-unit progress
  // (monotonic across fetch → decrypt → remux) so it drives the bar
  // without resetting at stage boundaries. The label shows just the
  // current stage — the per-stage segment counter is intentionally
  // omitted so the bar stays calm.
  const total = state.total > 0 ? state.total : 0;
  const current = state.current > 0 ? state.current : 0;
  const pct = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
  const label = stageLabel(state.stage);
  return `
    <div class="download-progress" role="progressbar"
         aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100">
      <div class="progress-bar"><div class="progress-fill" style="width: ${pct}%"></div></div>
      <div class="progress-row">
        <div class="progress-label">${pct}% &#x00b7; ${escapeHtml(label)}</div>
        <button type="button" class="cancel-download" data-request-id="${escapeHtml(state.requestId)}" title="Cancel">
          &#x2715;
        </button>
      </div>
    </div>`;
}

function renderRow(entry: MediaEntry): string {
  const title = entryTitle(entry);
  const section = entrySection(entry);
  const defaultFilename = entryFilename(entry);
  const badges = entryBadges(entry);
  const isDrm = entry.drm === true;
  const downloadState = downloadsByMediaId.get(entry.id) || null;

  // Master playlists need their variant list parsed before we can pick a
  // concrete media URL. Until then the select shows "Loading…" — clicking
  // would fall back to entry.url (the master) and the downloader rejects
  // it with UnsupportedFormatError. Disable the button until a real
  // variant exists or we've confirmed this is a single-bitrate playlist.
  const isReady =
    !!entry.parseError === false &&
    ((Array.isArray(entry.variants) && entry.variants.length > 0) || entry.isMaster === false);
  let action: string;
  if (isDrm) {
    action =
      '<span class="drm-label" title="Encrypted with a DRM system the extension cannot decrypt.">DRM-protected</span>';
  } else if (downloadState) {
    // A download for this entry is in flight, saved, or errored. Show its
    // status in place of the Download button.
    action = renderActionForDownload(downloadState);
  } else if (!isReady) {
    action =
      '<button type="button" class="download" disabled title="Waiting for the manifest to load.">Download &#x2193;</button>';
  } else {
    action = '<button type="button" class="download">Download &#x2193;</button>';
  }
  // Once a download is under way, the quality picker is locked in and
  // the select would just compete with the progress UI for row width. We
  // hide it so the status block (progress bar / saved pill / error) gets
  // the full action row to itself.
  const qualitySelect = downloadState
    ? ''
    : `<select class="quality" aria-label="Quality">${qualityOptionsHtml(entry)}</select>`;

  // Best-effort duration / size — only known once a media playlist has
  // been parsed. The popup keeps both as separate badges so future
  // additions (codec, etc.) can slot in alongside. Size is computed
  // per-variant from BANDWIDTH × duration; the change handler below
  // patches it when the user picks a different quality.
  const defaultVariantUrl =
    entry.isMaster === false ? entry.url : (entry.variants?.[0]?.url ?? entry.url);
  const dur = resolveDurationSeconds(entry, defaultVariantUrl);
  const size = resolveSizeBytes(entry, defaultVariantUrl);
  const metaParts: string[] = [];
  const durLabel = formatDuration(dur);
  if (durLabel) metaParts.push(`<span class="stat">${escapeHtml(durLabel)}</span>`);
  const sizeLabel = formatSize(size);
  if (sizeLabel) {
    metaParts.push(`<span class="stat stat-size">~${escapeHtml(sizeLabel)}</span>`);
  }
  for (const b of badges) metaParts.push(`<span class="badge">${escapeHtml(b)}</span>`);
  const metaHtml = metaParts.join(' &middot; ');

  // Editable filename — pre-filled with the adapter-derived name; the
  // download click reads the input's value and sanitizes it server-side.
  // Locked into a read-only static label once the download starts so the
  // user can still see what was saved. The locked label uses the SW's
  // resolved filename (which honors the user's edit) rather than the
  // adapter default, so an edited name doesn't visually revert at click.
  const lockedFilename = downloadState?.filename?.replace(/\.mp4$/, '') || defaultFilename;
  const filenameField = downloadState
    ? `<div class="filename-static" title="${escapeHtml(lockedFilename)}">${escapeHtml(lockedFilename)}</div>`
    : `<input type="text" class="filename-input" spellcheck="false" autocomplete="off"
         aria-label="Filename" value="${escapeHtml(defaultFilename)}"
         data-default="${escapeHtml(defaultFilename)}" />`;

  return `
    <div class="row" data-media-id="${escapeHtml(entry.id)}">
      <div class="row-header">
        <span class="row-section" title="${escapeHtml(entry.pageUrl)}">${escapeHtml(section)}</span>
        <span class="adapter-pill">${escapeHtml(entry.adapterId)}</span>
      </div>
      <div class="row-title" title="${escapeHtml(title)}">${escapeHtml(title)}</div>
      <div class="row-filename">${filenameField}</div>
      <div class="row-meta">${metaHtml}</div>
      <div class="row-actions">
        ${qualitySelect}
        ${action}
      </div>
    </div>
  `;
}

interface TabStateMsg {
  entries: MediaEntry[];
}

// Map<id, MediaEntry> for O(1) lookup from the delegated click handler.
let entriesById = new Map<string, MediaEntry>();

// Map<mediaId, DownloadState>. Populated by DOWNLOAD_STATE messages from
// the SW. `renderRow` consults this Map to swap the Download button for a
// progress bar / saved pill / error label as the state machine advances.
const downloadsByMediaId = new Map<string, DownloadState>();

// Last tab state we rendered. DOWNLOAD_STATE arrives independently from
// STATE — when only a download update lands we still need to redraw the
// same entry list, so we keep a reference and re-call render() with it.
let lastTabState: TabStateMsg = { entries: [] };

// Preserve user-controlled form values across re-renders so a quality
// pick or an edited filename doesn't get wiped by every progress push.
interface FormSnapshot {
  selects: Map<string, string>;
  // Map<mediaId, edited filename> — only captures user-typed values
  // (different from the default rendered into the input).
  filenames: Map<string, string>;
}

function captureFormState(): FormSnapshot {
  const selects = new Map<string, string>();
  for (const sel of $content.querySelectorAll<HTMLSelectElement>('.row select')) {
    const row = sel.closest<HTMLElement>('.row');
    const id = row?.dataset.mediaId;
    if (id) selects.set(`${id}::${sel.className}`, sel.value);
  }
  const filenames = new Map<string, string>();
  for (const input of $content.querySelectorAll<HTMLInputElement>('.filename-input')) {
    const row = input.closest<HTMLElement>('.row');
    const id = row?.dataset.mediaId;
    if (!id) continue;
    const def = input.dataset.default ?? '';
    // Skip un-edited inputs so a re-render with a fresh default name
    // (e.g. PAGE_META lands and changes filenameHint) takes effect.
    if (input.value !== def) filenames.set(id, input.value);
  }
  return { selects, filenames };
}

function restoreFormState(snap: FormSnapshot): void {
  for (const sel of $content.querySelectorAll<HTMLSelectElement>('.row select')) {
    const row = sel.closest<HTMLElement>('.row');
    const id = row?.dataset.mediaId;
    if (!id) continue;
    const saved = snap.selects.get(`${id}::${sel.className}`);
    if (saved == null) continue;
    // Only restore if the option still exists post-render (v0.5 manifest
    // re-parse could yield a different variant set).
    for (const opt of sel.options) {
      if (opt.value === saved) {
        sel.value = saved;
        break;
      }
    }
  }
  for (const input of $content.querySelectorAll<HTMLInputElement>('.filename-input')) {
    const row = input.closest<HTMLElement>('.row');
    const id = row?.dataset.mediaId;
    if (!id) continue;
    const saved = snap.filenames.get(id);
    if (saved != null) input.value = saved;
  }
}

function render(state: TabStateMsg | null | undefined): void {
  lastTabState = state ?? { entries: [] };
  const rawEntries = lastTabState.entries ?? [];
  entriesById = new Map(rawEntries.map((e) => [e.id, e] as const));
  const visible = filterTopLevel(rawEntries);
  if (visible.length === 0) {
    $content.innerHTML = renderEmpty();
    return;
  }
  const snap = captureFormState();
  $content.innerHTML = visible.map(renderRow).join('');
  restoreFormState(snap);
}

function applyDownloadState(state: DownloadState): void {
  if (!state || typeof state.mediaId !== 'string') return;
  const prev = downloadsByMediaId.get(state.mediaId);
  downloadsByMediaId.set(state.mediaId, state);

  // Fast path for progress-only updates. Each segment fetch fires a
  // DOWNLOAD_PROGRESS, and a full innerHTML re-render on every tick
  // tears down + rebuilds the row's DOM — that's what was making the
  // hover state blink and discarding any in-flight focus on the
  // filename input. Patch the progress bar + label in place when the
  // row's UI shape (status) hasn't changed.
  const isLiveProgress = (s: DownloadState | undefined): boolean =>
    !!s && (s.status === 'pending' || s.status === 'progress');
  if (isLiveProgress(prev) && isLiveProgress(state)) {
    const row = $content.querySelector<HTMLElement>(
      `.row[data-media-id="${CSS.escape(state.mediaId)}"]`,
    );
    const progressBar = row?.querySelector<HTMLElement>('.download-progress');
    const fill = progressBar?.querySelector<HTMLElement>('.progress-fill');
    const label = progressBar?.querySelector<HTMLElement>('.progress-label');
    if (progressBar && fill && label) {
      const total = state.total > 0 ? state.total : 0;
      const current = state.current > 0 ? state.current : 0;
      const pct = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
      const lbl = stageLabel(state.stage);
      fill.style.width = `${pct}%`;
      label.textContent = `${pct}% · ${lbl}`;
      // aria-valuenow belongs on the role="progressbar" element, not on
      // the surrounding .row container.
      progressBar.setAttribute('aria-valuenow', String(pct));
      return;
    }
  }

  // Status transition (pending → saved / error, or first state for this
  // row): the row's structure changes, so a full re-render is needed.
  render(lastTabState);
}

function dismissDownload(mediaId: string): void {
  // Optimistic local clear so the row updates instantly; the SW broadcasts
  // a matching DOWNLOAD_DISMISSED via the port shortly after.
  downloadsByMediaId.delete(mediaId);
  render(lastTabState);
  chrome.runtime.sendMessage({ type: MSG.DISMISS_DOWNLOAD, payload: { mediaId } }).catch(() => {});
}

function cancelDownload(requestId: string): void {
  // The SW transitions to 'canceled' synchronously and broadcasts a
  // DOWNLOAD_STATE update; the row repaints with the canceled UI as
  // soon as that arrives. No optimistic local mutation here — the
  // requestId is the canonical key and we want the SW's view to win.
  chrome.runtime.sendMessage({ type: MSG.CANCEL_DOWNLOAD, payload: { requestId } }).catch(() => {});
}

// Delegated change listener for the quality picker. Recomputes the
// estimated file size from the picked variant's BANDWIDTH × duration
// and patches the row's `.stat-size` text in place. No re-render — the
// filename input + hover state stay intact.
$content.addEventListener('change', (e: Event) => {
  const target = e.target as HTMLElement | null;
  const sel = target?.closest<HTMLSelectElement>('.quality');
  if (!sel) return;
  const row = sel.closest<HTMLElement>('.row');
  const id = row?.dataset.mediaId;
  if (!id) return;
  const entry = entriesById.get(id);
  if (!entry) return;
  const chosen = sel.value;
  const variantUrl = /^https?:/.test(chosen) ? chosen : entry.url;
  const dur = resolveDurationSeconds(entry, variantUrl);
  const bytes = resolveSizeBytes(entry, variantUrl);
  const sizeStat = row?.querySelector<HTMLElement>('.stat-size');
  if (!sizeStat) return;
  if (bytes > 0 && dur > 0) {
    sizeStat.textContent = `~${formatSize(bytes)}`;
  } else {
    // Some master playlists declare BANDWIDTH on every variant except
    // one (e.g. an audio-only fallback). Clear the badge so we don't
    // show a stale figure from the previously-chosen variant.
    sizeStat.textContent = '';
  }
});

// Single delegated click listener — no per-button wiring, no reliance on
// "the latest render's array reference". Lookup via the Map for O(1).
$content.addEventListener('click', (e: MouseEvent) => {
  const target = e.target as HTMLElement | null;
  // "Show in folder" on a saved download row.
  const showBtn = target?.closest<HTMLElement>('.show-in-folder');
  if (showBtn) {
    const downloadId = Number(showBtn.dataset.downloadId);
    if (Number.isFinite(downloadId)) {
      chrome.runtime
        .sendMessage({ type: MSG.SHOW_IN_FOLDER, payload: { downloadId } })
        .catch(() => {});
    }
    return;
  }

  // "Download again" (on a saved row) / "Retry" (on an error row).
  const dismissBtn = target?.closest<HTMLElement>('.dismiss-download');
  if (dismissBtn) {
    const mediaId = dismissBtn.dataset.mediaId;
    if (mediaId) dismissDownload(mediaId);
    return;
  }

  // "Cancel" on an in-flight progress row.
  const cancelBtn = target?.closest<HTMLElement>('.cancel-download');
  if (cancelBtn) {
    const requestId = cancelBtn.dataset.requestId;
    if (requestId) cancelDownload(requestId);
    return;
  }

  const btn = target?.closest<HTMLButtonElement>('.download');
  if (!btn || btn.disabled) return;
  const row = btn.closest<HTMLElement>('.row');
  const id = row?.dataset.mediaId;
  if (!id) return;
  const entry = entriesById.get(id);
  if (!entry) return;
  // Resolve the chosen variant URL from the row's <select>. A real URL
  // (one of entry.variants[].url) takes precedence; otherwise fall back to
  // the entry's own URL (single-bitrate / unparsed cases).
  const sel = row.querySelector<HTMLSelectElement>('.quality');
  const chosen = sel?.value;
  // Only fall back to entry.url when this is a known single-bitrate
  // (media) playlist. If the entry is a master without parsed variants,
  // entry.url IS the master URL and the downloader would reject it.
  let variantUrl: string;
  if (typeof chosen === 'string' && /^https?:/.test(chosen)) {
    variantUrl = chosen;
  } else if (entry.isMaster === false) {
    variantUrl = entry.url;
  } else {
    log.warn('[VDL] download blocked — manifest not parsed yet', { mediaId: entry.id });
    return;
  }

  // Pull the (possibly user-edited) filename from the input. SW will
  // sanitize it and fall back to the adapter-derived name if it's empty
  // post-sanitize.
  const filenameInput = row.querySelector<HTMLInputElement>('.filename-input');
  const filenameOverride = filenameInput?.value?.trim();

  log.info('[VDL] download clicked', {
    mediaId: entry.id,
    adapterId: entry.adapterId,
    kind: entry.kind,
    variantUrl: redactUrl(variantUrl),
    filename: filenameOverride ?? null,
  });

  chrome.runtime
    .sendMessage({
      type: MSG.START_DOWNLOAD,
      payload: { mediaId: entry.id, variantUrl, filename: filenameOverride },
    })
    .then((resp) => {
      log.debug('[VDL] start ack', resp);
    })
    .catch((err) => {
      log.warn('[VDL] start failed', err);
    });
});

// ---------- live subscription via SW port ----------

async function activeTabId(): Promise<number | null> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab?.id ?? null;
  } catch {
    return null;
  }
}

const MAX_RECONNECT_ATTEMPTS = 8;
let port: chrome.runtime.Port | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryCount = 0;

function connect(tabId: number): void {
  try {
    port = chrome.runtime.connect({ name: 'popup' });
  } catch {
    // SW is down — retry shortly.
    scheduleReconnect(tabId);
    return;
  }
  port.postMessage({ type: 'SUBSCRIBE', tabId });
  port.onMessage.addListener((rawMsg: unknown) => {
    const msg = parsePortMessageFromSW(rawMsg);
    if (!msg) return;
    if (msg.type === 'STATE') {
      retryCount = 0; // first successful subscription resets the budget
      render(msg.state);
    } else if (msg.type === 'DOWNLOAD_STATE') {
      applyDownloadState(msg.state);
    } else if (msg.type === 'DOWNLOAD_DISMISSED') {
      downloadsByMediaId.delete(msg.mediaId);
      render(lastTabState);
    }
  });
  port.onDisconnect.addListener(() => {
    port = null;
    scheduleReconnect(tabId);
  });
}

function scheduleReconnect(tabId: number): void {
  if (retryTimer) return;
  if (retryCount >= MAX_RECONNECT_ATTEMPTS) {
    log.warn('[VDL] popup gave up reconnecting after', MAX_RECONNECT_ATTEMPTS, 'attempts');
    return;
  }
  retryCount += 1;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect(tabId);
  }, 250);
}

// Bootstrap
(async () => {
  const tabId = await activeTabId();
  if (tabId == null) {
    $content.innerHTML = renderEmpty();
    return;
  }
  // Render whatever state we can immediately so the popup isn't blank
  // during the connect roundtrip. The SUBSCRIBE response will overwrite.
  render({ entries: [] });
  connect(tabId);
})();
