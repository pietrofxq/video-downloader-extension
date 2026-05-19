import { redactUrl } from '../lib/log.js';

const $content = document.getElementById('content');
const $footer = document.getElementById('footer');
const $gear = document.getElementById('open-options');

$gear?.addEventListener('click', () => chrome.runtime.openOptionsPage?.());

// ---------- helpers ----------

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[c],
  );
}

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
  // v0.5+ will add encryption / DRM badges parsed from the manifest.
  return out;
}

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
          <option value="auto">Auto (v0.5 will populate)</option>
        </select>
        ${action}
      </div>
    </div>
  `;
}

let lastEntries = [];

function render(state) {
  const entries = state?.entries ?? [];
  lastEntries = entries;
  if (entries.length === 0) {
    $content.innerHTML = renderEmpty();
    $footer.classList.add('hidden');
    return;
  }
  $content.innerHTML = entries.map(renderRow).join('');
  $footer.classList.remove('hidden');
  for (const btn of $content.querySelectorAll('.download')) {
    btn.addEventListener('click', () => {
      const row = btn.closest('.row');
      const id = row?.dataset.mediaId;
      const entry = lastEntries.find((e) => e.id === id);
      if (!entry) return;
      // v0.6 will dispatch START_DOWNLOAD with this. For now, log so devs
      // can confirm the wiring + see the redacted URL.
      // eslint-disable-next-line no-console
      console.log('[VDL] download clicked', {
        mediaId: entry.id,
        adapterId: entry.adapterId,
        kind: entry.kind,
        url: redactUrl(entry.url),
      });
    });
  }
}

// ---------- live subscription via SW port ----------

async function activeTabId() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab?.id ?? null;
  } catch {
    return null;
  }
}

let port = null;
let retryTimer = null;

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
    if (msg?.type === 'STATE') render(msg.state);
  });
  port.onDisconnect.addListener(() => {
    port = null;
    scheduleReconnect(tabId);
  });
}

function scheduleReconnect(tabId) {
  if (retryTimer) return;
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
