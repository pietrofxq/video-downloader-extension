import { escapeHtml } from '../lib/dom-utils.js';
import { filterTopLevel } from '../lib/entry-filter.js';
import { log, redactUrl } from '../lib/log.js';
import { MSG } from '../lib/messages.js';

const $content = document.getElementById('content');
const $footer = document.getElementById('footer');
const $gear = document.getElementById('open-options');

$gear?.addEventListener('click', () => chrome.runtime.openOptionsPage?.());

// ---------- helpers ----------

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function basenameFromUrl(url) {
  try {
    const u = new URL(url);
    return u.pathname.split('/').filter(Boolean).pop() || u.host;
  } catch {
    return url;
  }
}

const KIND_LABELS = {
  hls: 'HLS',
  dash: 'DASH',
  progressive: 'MP4/WebM',
};

function entryTitle(entry) {
  const m = entry.meta ?? {};
  return m.lessonTitle || m.title || m.ogTitle || m.ogVideoTitle || basenameFromUrl(entry.url);
}

function entrySection(entry) {
  const m = entry.meta ?? {};
  return m.sectionTitle || m.ogSiteName || safeHost(entry.pageUrl) || safeHost(entry.url);
}

function entryFilename(entry) {
  return entry.meta?.filenameHint || basenameFromUrl(entry.url);
}

function entryBadges(entry) {
  const out = [];
  const kind = KIND_LABELS[entry.kind] || entry.kind;
  if (kind) out.push(kind);
  if (entry.parseError) out.push('manifest unavailable');
  // v1.1 will add encryption / DRM badges when DASH ContentProtection lands.
  // v0.6's HLS pipeline handles AES-128 at the segment level inside the
  // offscreen orchestrator — it doesn't surface on the entry, by design.
  return out;
}

function formatVariant(v) {
  const resPart = v.resolution?.includes('x')
    ? `${v.resolution.split('x')[1]}p`
    : v.resolution || '';
  const bwPart = v.bandwidth ? `${Math.round(v.bandwidth / 1000)} kbps` : '';
  if (resPart && bwPart) return `${resPart} (${bwPart})`;
  return resPart || bwPart || 'variant';
}

function qualityOptionsHtml(entry) {
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
const ERROR_MESSAGES = {
  TokenExpiredError: 'Token expired. Reload the page and try again.',
  ManifestParseError: "Couldn't read the video manifest.",
  DecryptionError: 'Decryption failed. Try reloading the page.',
  RemuxError: "Couldn't repackage the video.",
  DRMProtectedError: "This stream is DRM-protected and can't be downloaded.",
  UnsupportedFormatError: 'Unsupported stream format.',
};

function friendlyErrorMessage(state) {
  return (
    ERROR_MESSAGES[state.errorCode] ||
    state.errorMessage ||
    'Download failed. Check the console for details.'
  );
}

function stageLabel(stage) {
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

function renderActionForDownload(state) {
  if (state.status === 'saved') {
    return `
      <div class="download-result saved">
        <span class="saved-pill">Saved &#x2713;</span>
        <button type="button" class="show-in-folder" data-download-id="${state.downloadId}">
          Show in folder
        </button>
      </div>`;
  }
  if (state.status === 'error') {
    return `
      <div class="download-result error" title="${escapeHtml(state.errorMessage || '')}">
        <span class="error-label">${escapeHtml(friendlyErrorMessage(state))}</span>
      </div>`;
  }
  // pending / progress
  const total = state.total > 0 ? state.total : 0;
  const current = state.current > 0 ? state.current : 0;
  const pct = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
  const counter = total > 0 ? `segment ${current}/${total}` : '';
  const label = [stageLabel(state.stage), counter].filter(Boolean).join(' · ');
  return `
    <div class="download-progress" role="progressbar"
         aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100">
      <div class="progress-bar"><div class="progress-fill" style="width: ${pct}%"></div></div>
      <div class="progress-label">${pct}% &#x00b7; ${escapeHtml(label)}</div>
    </div>`;
}

function renderRow(entry) {
  const title = entryTitle(entry);
  const section = entrySection(entry);
  const filename = entryFilename(entry);
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
  let action;
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
  return `
    <div class="row" data-media-id="${escapeHtml(entry.id)}">
      <div class="row-header">
        <span class="row-section" title="${escapeHtml(entry.pageUrl)}">${escapeHtml(section)}</span>
        <span class="adapter-pill">${escapeHtml(entry.adapterId)}</span>
      </div>
      <div class="row-title" title="${escapeHtml(title)}">${escapeHtml(title)}</div>
      <div class="row-meta">${escapeHtml(filename)}${badges.length ? ' &middot; ' + badges.map((b) => `<span class="badge">${escapeHtml(b)}</span>`).join(' &middot; ') : ''}</div>
      <div class="row-actions">
        ${qualitySelect}
        ${action}
      </div>
    </div>
  `;
}

// Map<id, MediaEntry> for O(1) lookup from the delegated click handler.
let entriesById = new Map();

// Map<mediaId, DownloadState>. Populated by DOWNLOAD_STATE messages from
// the SW. `renderRow` consults this Map to swap the Download button for a
// progress bar / saved pill / error label as the state machine advances.
const downloadsByMediaId = new Map();

// Last tab state we rendered. DOWNLOAD_STATE arrives independently from
// STATE — when only a download update lands we still need to redraw the
// same entry list, so we keep a reference and re-call render() with it.
let lastTabState = { entries: [] };

// Preserve user selections in <select> elements across re-renders so a
// quality pick doesn't get wiped by every push update. Captures by
// (mediaId, select-class) to handle multiple selects per row in the future.
function captureSelectState() {
  const state = new Map();
  for (const sel of $content.querySelectorAll('.row select')) {
    const row = sel.closest('.row');
    const id = row?.dataset.mediaId;
    if (id) state.set(`${id}::${sel.className}`, sel.value);
  }
  return state;
}

function restoreSelectState(state) {
  for (const sel of $content.querySelectorAll('.row select')) {
    const row = sel.closest('.row');
    const id = row?.dataset.mediaId;
    if (!id) continue;
    const saved = state.get(`${id}::${sel.className}`);
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
}

function render(state) {
  lastTabState = state ?? { entries: [] };
  const rawEntries = lastTabState.entries ?? [];
  entriesById = new Map(rawEntries.map((e) => [e.id, e]));
  const visible = filterTopLevel(rawEntries);
  if (visible.length === 0) {
    $content.innerHTML = renderEmpty();
    $footer.classList.add('hidden');
    return;
  }
  const selectState = captureSelectState();
  $content.innerHTML = visible.map(renderRow).join('');
  $footer.classList.remove('hidden');
  restoreSelectState(selectState);
}

function applyDownloadState(state) {
  if (!state || typeof state.mediaId !== 'string') return;
  downloadsByMediaId.set(state.mediaId, state);
  // Re-render the current tab state — renderRow consults downloadsByMediaId
  // when picking the action UI. We don't get a fresh STATE for every progress
  // message, so re-using the cached one is the load-bearing bit here.
  render(lastTabState);
}

// Single delegated click listener — no per-button wiring, no reliance on
// "the latest render's array reference". Lookup via the Map for O(1).
$content.addEventListener('click', (e) => {
  // "Show in folder" on a saved download row.
  const showBtn = e.target.closest('.show-in-folder');
  if (showBtn) {
    const downloadId = Number(showBtn.dataset.downloadId);
    if (Number.isFinite(downloadId)) {
      chrome.runtime
        .sendMessage({ type: MSG.SHOW_IN_FOLDER, payload: { downloadId } })
        .catch(() => {});
    }
    return;
  }

  const btn = e.target.closest('.download');
  if (!btn || btn.disabled) return;
  const row = btn.closest('.row');
  const id = row?.dataset.mediaId;
  if (!id) return;
  const entry = entriesById.get(id);
  if (!entry) return;
  // Resolve the chosen variant URL from the row's <select>. A real URL
  // (one of entry.variants[].url) takes precedence; otherwise fall back to
  // the entry's own URL (single-bitrate / unparsed cases).
  const sel = row.querySelector('.quality');
  const chosen = sel?.value;
  // Only fall back to entry.url when this is a known single-bitrate
  // (media) playlist. If the entry is a master without parsed variants,
  // entry.url IS the master URL and the downloader would reject it.
  let variantUrl;
  if (typeof chosen === 'string' && /^https?:/.test(chosen)) {
    variantUrl = chosen;
  } else if (entry.isMaster === false) {
    variantUrl = entry.url;
  } else {
    log.warn('[VDL] download blocked — manifest not parsed yet', { mediaId: entry.id });
    return;
  }

  log.info('[VDL] download clicked', {
    mediaId: entry.id,
    adapterId: entry.adapterId,
    kind: entry.kind,
    variantUrl: redactUrl(variantUrl),
  });

  chrome.runtime
    .sendMessage({
      type: MSG.START_DOWNLOAD,
      payload: { mediaId: entry.id, variantUrl },
    })
    .then((resp) => {
      log.debug('[VDL] start ack', resp);
    })
    .catch((err) => {
      log.warn('[VDL] start failed', err);
    });
});

// ---------- live subscription via SW port ----------

async function activeTabId() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab?.id ?? null;
  } catch {
    return null;
  }
}

const MAX_RECONNECT_ATTEMPTS = 8;
let port = null;
let retryTimer = null;
let retryCount = 0;

function connect(tabId) {
  try {
    port = chrome.runtime.connect({ name: 'popup' });
  } catch {
    // SW is down — retry shortly.
    scheduleReconnect(tabId);
    return;
  }
  port.postMessage({ type: 'SUBSCRIBE', tabId });
  port.onMessage.addListener((msg) => {
    if (msg?.type === 'STATE') {
      retryCount = 0; // first successful subscription resets the budget
      render(msg.state);
    } else if (msg?.type === 'DOWNLOAD_STATE') {
      applyDownloadState(msg.state);
    }
  });
  port.onDisconnect.addListener(() => {
    port = null;
    scheduleReconnect(tabId);
  });
}

function scheduleReconnect(tabId) {
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
