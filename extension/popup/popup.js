import { escapeHtml } from '../lib/dom-utils.js';
import { filterTopLevel } from '../lib/entry-filter.js';
import { redactUrl } from '../lib/log.js';

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
  // v0.6+ will add encryption / DRM badges parsed from segments + ContentProtection.
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

function renderRow(entry) {
  const title = entryTitle(entry);
  const section = entrySection(entry);
  const filename = entryFilename(entry);
  const badges = entryBadges(entry);
  const isDrm = entry.drm === true;
  const action = isDrm
    ? '<span class="drm-label" title="Encrypted with a DRM system the extension cannot decrypt.">DRM-protected</span>'
    : '<button type="button" class="download">Download &#x2193;</button>';
  return `
    <div class="row" data-media-id="${escapeHtml(entry.id)}">
      <div class="row-header">
        <span class="row-section" title="${escapeHtml(entry.pageUrl)}">${escapeHtml(section)}</span>
        <span class="adapter-pill">${escapeHtml(entry.adapterId)}</span>
      </div>
      <div class="row-title" title="${escapeHtml(title)}">${escapeHtml(title)}</div>
      <div class="row-meta">${escapeHtml(filename)}${badges.length ? ' &middot; ' + badges.map((b) => `<span class="badge">${escapeHtml(b)}</span>`).join(' &middot; ') : ''}</div>
      <div class="row-actions">
        <select class="quality" aria-label="Quality">
          ${qualityOptionsHtml(entry)}
        </select>
        ${action}
      </div>
    </div>
  `;
}

// Map<id, MediaEntry> for O(1) lookup from the delegated click handler.
let entriesById = new Map();

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
  const rawEntries = state?.entries ?? [];
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

// Single delegated click listener — no per-button wiring, no reliance on
// "the latest render's array reference". Lookup via the Map for O(1).
$content.addEventListener('click', (e) => {
  const btn = e.target.closest('.download');
  if (!btn) return;
  const row = btn.closest('.row');
  const id = row?.dataset.mediaId;
  if (!id) return;
  const entry = entriesById.get(id);
  if (!entry) return;
  // v0.6 will dispatch START_DOWNLOAD. For now, log so devs can confirm
  // wiring + see the redacted URL.
  // eslint-disable-next-line no-console
  console.log('[VDL] download clicked', {
    mediaId: entry.id,
    adapterId: entry.adapterId,
    kind: entry.kind,
    url: redactUrl(entry.url),
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
    // eslint-disable-next-line no-console
    console.warn('[VDL] popup gave up reconnecting after', MAX_RECONNECT_ATTEMPTS, 'attempts');
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
