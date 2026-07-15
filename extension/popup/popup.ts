import { escapeHtml } from '../lib/dom-utils.js';
import { filterTopLevel } from '../lib/entry-filter.js';
import { log, redactUrl } from '../lib/log.js';
import { MSG, parsePortMessageFromSW } from '../lib/messages.js';
import { sanitizeFilename } from '../lib/sanitize-filename.js';
import type { DownloadStage, DownloadState, MediaEntry } from '../lib/types.ts';
import {
  formatAudioTrack,
  formatVariant,
  hasAudioTrackPicker,
  isManifestLoading,
  pickDefaultAudioTrackId,
  pickDisplayVariantUrl,
  pickDownloadVariantUrl,
  pickPreferredVariantUrl,
  qualityPickerState,
  sortOrphansForDisplay,
} from './popup-helpers.js';
import {
  getLastQualityHeight,
  getSettings,
  setLastQualityHeight,
  type DefaultQuality,
} from '../lib/settings.js';

// The user's default-quality preference + the last height they manually
// picked, loaded once at startup. Together they drive which option
// qualityOptionsHtml pre-selects (last-picked wins when present).
let defaultQualityPref: DefaultQuality = 'highest';
let lastQualityHeight: number | null = null;

const $content = document.getElementById('content')!;
const $gear = document.getElementById('open-options');
const $reset = document.getElementById('reset-tab');
const $version = document.getElementById('ext-version');

// Stamp the running extension version into the header (read from the
// manifest so it stays in sync with package.json/manifest.json bumps).
if ($version) {
  try {
    $version.textContent = `v${chrome.runtime.getManifest().version}`;
  } catch {
    // getManifest can't realistically throw in an extension page; ignore.
  }
}

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
//      For adaptive variants with a paired audio stream, the audio's
//      contentLength is added so the displayed estimate reflects the
//      final muxed MP4.
//   2. BANDWIDTH × duration / 8 (HLS — master declares bandwidth, media
//      playlist has duration).
// Returns 0 when neither path resolves; the popup hides the badge.
function resolveSizeBytes(entry: MediaEntry, variantUrl: string | undefined): number {
  if (variantUrl && Array.isArray(entry.variants)) {
    const v = entry.variants.find((x) => x.url === variantUrl);
    if (v?.contentLength && v.contentLength > 0) {
      return v.contentLength + (v.pairedAudioContentLength ?? 0);
    }
    const dur = resolveDurationSeconds(entry, variantUrl);
    if (dur > 0 && v && v.bandwidth > 0) return Math.round((v.bandwidth * dur) / 8);
  }
  return 0;
}

function audioTrackOptionsHtml(entry: MediaEntry, selectedId: string | null): string {
  const tracks = entry.audioTracks ?? [];
  return tracks
    .map((t) => {
      const sel = t.id === selectedId ? ' selected' : '';
      return `<option value="${escapeHtml(t.id)}"${sel}>${escapeHtml(formatAudioTrack(t))}</option>`;
    })
    .join('');
}

// Height from a "WxH" resolution string; 0 when absent/unparsed. Used to
// tag quality <option>s so the change handler can remember the picked
// height (the sticky last-quality default).
function variantHeightFromResolution(resolution: string | null | undefined): number {
  if (!resolution) return 0;
  const m = /x(\d+)/.exec(resolution);
  return m ? Number(m[1]) : 0;
}

function qualityOptionsHtml(entry: MediaEntry): string {
  // qualityPickerState centralizes the state machine (shared with the
  // "Loading…" watchdog); this just maps each state to <option>s. The
  // muxer-unsupported variants (VP9/AV1-only, video-only without paired
  // audio) are already filtered out by the 'variants' case, so the
  // dropdown never leads with an unselectable junk option.
  const state = qualityPickerState(entry);
  switch (state.kind) {
    case 'parse-error':
      return '<option value="auto">Couldn’t read manifest</option>';
    case 'no-supported':
      return '<option value="none">No supported quality</option>';
    case 'single':
      return '<option value="single">Single quality</option>';
    case 'loading':
      return '<option value="auto">Loading…</option>';
    case 'variants': {
      const preferredUrl = pickPreferredVariantUrl(
        state.variants,
        defaultQualityPref,
        lastQualityHeight,
      );
      return state.variants
        .map((v) => {
          const sel = v.url === preferredUrl ? ' selected' : '';
          const h = variantHeightFromResolution(v.resolution);
          const hAttr = h > 0 ? ` data-height="${h}"` : '';
          return `<option value="${escapeHtml(v.url)}"${hAttr}${sel}>${escapeHtml(formatVariant(v))}</option>`;
        })
        .join('');
    }
  }
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

  // Readiness comes from the quality picker's state machine so the
  // button and the dropdown can never disagree: 'variants' / 'single'
  // are downloadable; 'loading' / 'parse-error' / 'no-supported' keep
  // the button disabled (clicking would hand the downloader a master
  // URL it rejects with UnsupportedFormatError, or nothing at all).
  const pickerState = qualityPickerState(entry);
  const isReady = pickerState.kind === 'variants' || pickerState.kind === 'single';
  let action: string;
  if (isDrm) {
    action =
      '<span class="drm-label" title="Encrypted with a DRM system the extension cannot decrypt.">DRM-protected</span>';
  } else if (downloadState) {
    // A download for this entry is in flight, saved, or errored. Show its
    // status in place of the Download button.
    action = renderActionForDownload(downloadState);
  } else if (!isReady) {
    const reason =
      pickerState.kind === 'parse-error'
        ? 'Couldn&#x2019;t read the video manifest.'
        : pickerState.kind === 'no-supported'
          ? 'No downloadable quality available.'
          : 'Waiting for the manifest to load.';
    action = `<button type="button" class="download" disabled title="${reason}">Download &#x2193;</button>`;
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

  // Audio-track picker — only when the entry actually has multiple
  // tracks (YouTube multi-dub videos). Hidden during downloads for the
  // same reason as the quality picker.
  const audioTrackSelect =
    !downloadState && hasAudioTrackPicker(entry)
      ? `<select class="audio-track" aria-label="Audio track">${audioTrackOptionsHtml(
          entry,
          pickDefaultAudioTrackId(entry, downloadState),
        )}</select>`
      : '';

  // Best-effort duration / size — only known once a media playlist has
  // been parsed. `pickDisplayVariantUrl` returns the URL the badges
  // should describe: the in-flight download's picked URL when one
  // exists (otherwise the size visibly "reverts" to variants[0] when
  // the dropdown is replaced by the in-progress UI), else the entry's
  // default. The change handler patches the badge live while the
  // dropdown is still visible.
  const defaultVariantUrl = pickDisplayVariantUrl(entry, downloadState);
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
        <span class="row-header-right">
          <button type="button" class="copy-url" data-media-id="${escapeHtml(entry.id)}"
                  title="Copy source URL (redacted)" aria-label="Copy source URL">&#x2398;</button>
          <span class="adapter-pill">${escapeHtml(entry.adapterId)}</span>
        </span>
      </div>
      <div class="row-title" title="${escapeHtml(title)}">${escapeHtml(title)}</div>
      <div class="row-filename">${filenameField}</div>
      <div class="row-meta">${metaHtml}</div>
      <div class="row-actions">
        ${qualitySelect}
        ${audioTrackSelect}
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

  // Cross-tab "Active downloads" section (v0.11.3). Any download state
  // whose mediaId isn't backed by a visible entry on THIS tab gets
  // surfaced here. Catches both downloads started from other tabs and
  // downloads whose tab navigated away / cleared its entry list.
  // The inline per-row progress UI (renderActionForDownload) still
  // handles downloads whose mediaId IS visible — they're not duplicated.
  const orphansRaw: DownloadState[] = [];
  for (const ds of downloadsByMediaId.values()) {
    if (!entriesById.has(ds.mediaId)) orphansRaw.push(ds);
  }
  // Group live downloads above finished ones (each newest-first).
  const orphans = sortOrphansForDisplay(orphansRaw);

  const snap = captureFormState();
  const orphanHtml = orphans.length > 0 ? renderOrphanSection(orphans) : '';
  if (visible.length === 0 && orphans.length === 0) {
    $content.innerHTML = renderEmpty();
    armLoadingWatchdog(visible);
    return;
  }
  $content.innerHTML = orphanHtml + visible.map(renderRow).join('');
  restoreFormState(snap);
  // Re-drive any entry still stuck on "Loading…" (see armLoadingWatchdog).
  armLoadingWatchdog(visible);
}

function renderOrphanSection(orphans: DownloadState[]): string {
  const rows = orphans.map(renderOrphanRow).join('');
  return `
    <div class="orphan-section">
      <div class="orphan-section-title">Active downloads</div>
      ${rows}
    </div>
  `;
}

function renderOrphanRow(state: DownloadState): string {
  const snap = state.entrySnapshot;
  // Title: prefer the entry-snapshot title; fall back to the
  // filename (sans extension). Pre-v0.11.7 states won't have a
  // snapshot — the filename fallback keeps them looking sensible
  // until the SW restarts and the state expires.
  const displayName = (state.filename || '').replace(/\.[^.]+$/, '') || 'download';
  const title = snap?.title || displayName;
  // Section line: snapshot field if present, otherwise the
  // historical "tab #N" label so we never blank that area out.
  const section = snap?.section || `tab #${state.tabId}`;

  // Size badge: snapshot's variant + paired-audio contentLength.
  // Falls back to bandwidth × duration when contentLength is unset
  // (HLS variants don't publish it; YouTube does).
  const variantBytes = snap?.variantContentLength ?? 0;
  const pairedBytes = snap?.pairedAudioContentLength ?? 0;
  const duration = snap?.totalDuration ?? 0;
  let bytes = variantBytes + pairedBytes;
  if (bytes === 0 && duration > 0 && snap?.variantBandwidth) {
    bytes = Math.round((snap.variantBandwidth * duration) / 8);
  }

  const metaParts: string[] = [];
  const durLabel = formatDuration(duration);
  if (durLabel) metaParts.push(`<span class="stat">${escapeHtml(durLabel)}</span>`);
  const sizeLabel = formatSize(bytes);
  if (sizeLabel) metaParts.push(`<span class="stat stat-size">~${escapeHtml(sizeLabel)}</span>`);
  // Quality + codec tag (e.g. "1080p H.264") — same labeling the
  // quality dropdown uses so the orphan row reads like a paused
  // inline row.
  if (snap) {
    const qualityLabel = formatVariant({
      url: '',
      bandwidth: snap.variantBandwidth ?? 0,
      resolution: snap.variantResolution ?? null,
      codecs: snap.variantCodecs ?? null,
    });
    if (qualityLabel && qualityLabel !== 'variant') {
      metaParts.push(`<span class="badge">${escapeHtml(qualityLabel)}</span>`);
    }
  }
  // Kind badge (HLS / DASH / progressive). Skipped when no snapshot.
  if (snap?.kind) {
    metaParts.push(`<span class="badge">${escapeHtml(KIND_LABELS[snap.kind] || snap.kind)}</span>`);
  }
  const metaHtml = metaParts.join(' &middot; ');

  const action = renderActionForDownload(state);
  // For terminal states (saved/error/canceled) the user's mental
  // model is "I'm done with this — get it off my screen", not the
  // existing "↻ Again" affordance that the inline-row uses. Offer a
  // dedicated close button at top-right that maps to the same
  // dismiss-download handler (we just reuse the class so the
  // delegated click handler picks it up). In-flight states keep the
  // existing Cancel × from renderActionForDownload — adding a
  // second × here would be confusing.
  const isTerminal =
    state.status === 'saved' || state.status === 'error' || state.status === 'canceled';
  const removeBtn = isTerminal
    ? `<button type="button" class="orphan-remove dismiss-download" data-media-id="${escapeHtml(state.mediaId)}" title="Remove from list" aria-label="Remove from list">&#x2715;</button>`
    : '';
  // Optional adapter pill in the top-right when the snapshot
  // carries an adapterId — matches the inline row's header style.
  const adapterPill = snap?.adapterId
    ? `<span class="adapter-pill">${escapeHtml(snap.adapterId)}</span>`
    : '';
  return `
    <div class="row row-orphan" data-media-id="${escapeHtml(state.mediaId)}">
      ${removeBtn}
      <div class="row-header">
        <span class="row-section">${escapeHtml(section)}</span>
        ${adapterPill}
      </div>
      <div class="row-title" title="${escapeHtml(title)}">${escapeHtml(title)}</div>
      <div class="row-meta">${metaHtml}</div>
      <div class="row-actions">${action}</div>
    </div>
  `;
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

  // Remember the manually-picked height as the sticky default for the
  // next video's picker (the data-height we tagged the option with).
  const pickedHeight = Number(sel.selectedOptions[0]?.dataset.height);
  if (Number.isFinite(pickedHeight) && pickedHeight > 0) {
    lastQualityHeight = pickedHeight;
    void setLastQualityHeight(pickedHeight);
  }

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

  // "Copy source URL" — copies the redacted media URL for debugging a
  // failed download. Brief inline confirmation via the button title.
  const copyBtn = target?.closest<HTMLButtonElement>('.copy-url');
  if (copyBtn) {
    const entry = copyBtn.dataset.mediaId ? entriesById.get(copyBtn.dataset.mediaId) : null;
    if (entry) {
      void navigator.clipboard
        ?.writeText(redactUrl(entry.url))
        .then(() => {
          copyBtn.classList.add('copied');
          setTimeout(() => copyBtn.classList.remove('copied'), 1200);
        })
        .catch((err) => log.warn('[VDL] copy url failed', err));
    }
    return;
  }

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
  // Resolve the chosen variant URL from the row's <select>. The
  // helper takes (entry, dropdown value) and returns null only when
  // the entry is a master playlist whose variants haven't parsed yet
  // — defensive guard against the Download button being clicked
  // before isReady would have disabled it.
  const sel = row.querySelector<HTMLSelectElement>('.quality');
  const chosen = sel?.value;
  const variantUrl = pickDownloadVariantUrl(entry, chosen);
  if (variantUrl === null) {
    log.warn('[VDL] download blocked — manifest not parsed yet', { mediaId: entry.id });
    return;
  }

  // Pull the (possibly user-edited) filename from the input. SW will
  // sanitize it and fall back to the adapter-derived name if it's empty
  // post-sanitize.
  const filenameInput = row.querySelector<HTMLInputElement>('.filename-input');
  const filenameOverride = filenameInput?.value?.trim();

  // Audio-track id from the row's audio-track <select>, when the
  // picker was rendered (multi-dub videos). Omit when the entry has
  // only one track — SW falls back to the variant's default
  // pairedAudioUrl in that case.
  const audioSel = row.querySelector<HTMLSelectElement>('.audio-track');
  const audioTrackId = audioSel?.value || undefined;

  log.info('[VDL] download clicked', {
    mediaId: entry.id,
    adapterId: entry.adapterId,
    kind: entry.kind,
    variantUrl: redactUrl(variantUrl),
    filename: filenameOverride ?? null,
    audioTrackId: audioTrackId ?? null,
  });

  chrome.runtime
    .sendMessage({
      type: MSG.START_DOWNLOAD,
      payload: {
        mediaId: entry.id,
        variantUrl,
        filename: filenameOverride,
        ...(audioTrackId ? { audioTrackId } : {}),
      },
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
let currentTabId: number | null = null;

// ---------- "Loading…" watchdog ----------
//
// An HLS entry shows "Loading…" until the SW parses its manifest. The SW
// kicks off that parse eagerly on detection, but the MV3 worker can be
// torn down before the floating parse finishes — and if the popup is
// already open, nothing re-drives it (the SUBSCRIBE-time retry only runs
// on connect). So while any visible entry is stuck on "Loading…", nudge
// the SW to re-parse, spaced out and capped so a genuinely slow/broken
// manifest doesn't get hammered. ensureParsed is in-flight-guarded SW-
// side, so a nudge during a healthy in-flight parse is a no-op.
const WATCHDOG_DELAY_MS = 3000;
const MAX_PARSE_NUDGES = 6;
let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
const parseNudges = new Map<string, number>(); // mediaId -> nudge count

function armLoadingWatchdog(entries: MediaEntry[]): void {
  const stuck = entries.filter(isManifestLoading);
  const stuckWithBudget = stuck.filter((e) => (parseNudges.get(e.id) ?? 0) < MAX_PARSE_NUDGES);
  if (stuckWithBudget.length === 0) {
    // Nothing left to nudge — drop any pending timer.
    if (watchdogTimer) {
      clearTimeout(watchdogTimer);
      watchdogTimer = null;
    }
    return;
  }
  if (watchdogTimer) return; // already scheduled
  watchdogTimer = setTimeout(() => {
    watchdogTimer = null;
    const stillStuck = (lastTabState.entries ?? []).filter(isManifestLoading);
    let nudge = false;
    for (const e of stillStuck) {
      const n = parseNudges.get(e.id) ?? 0;
      if (n < MAX_PARSE_NUDGES) {
        parseNudges.set(e.id, n + 1);
        nudge = true;
      }
    }
    if (nudge && currentTabId != null) {
      chrome.runtime
        .sendMessage({ type: MSG.ENSURE_PARSED, payload: { tabId: currentTabId } })
        .catch(() => {
          // SW asleep / transient — the next render re-arms the watchdog.
        });
    }
  }, WATCHDOG_DELAY_MS);
}

function connect(tabId: number): void {
  currentTabId = tabId;
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
  // Load settings before the first render so the picker pre-selects the
  // user's preferred (or last-picked) quality on the very first paint.
  try {
    const settings = await getSettings();
    defaultQualityPref = settings.defaultQuality;
    lastQualityHeight = await getLastQualityHeight();
  } catch {
    /* keep the 'highest' default */
  }
  // Render whatever state we can immediately so the popup isn't blank
  // during the connect roundtrip. The SUBSCRIBE response will overwrite.
  render({ entries: [] });
  connect(tabId);
})();
