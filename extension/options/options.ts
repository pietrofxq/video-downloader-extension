import { log } from '../lib/log.js';
import { MSG } from '../lib/messages.js';
import {
  DEFAULT_SETTINGS,
  FILENAME_TEMPLATE_DEFAULTS,
  filenameTemplateFor,
  getSettings,
  normalizeHost,
  renderFilenameTemplate,
  setLastQualityHeight,
  setSettings,
  type DefaultQuality,
  type Settings,
} from '../lib/settings.js';
import { escapeHtml } from '../lib/dom-utils.js';

// Adapters shown in the Sites + Templates sections. Hardcoded (id + label)
// rather than imported from adapters/index so the options bundle doesn't
// pull in the adapters' scraping/parser dependencies (meriyah etc.).
const ADAPTER_INFO: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'hotmart', label: 'Hotmart Club' },
  { id: 'youtube', label: 'YouTube' },
  { id: 'default', label: 'All other sites' },
];

// Sample values for the filename-template live preview.
const SAMPLE_VARS = {
  title: 'My Video',
  section: 'Module 1',
  lesson: 'Lesson 3',
  channel: 'Creator',
  basename: 'video-720p',
  videoId: 'dQw4w9WgXcQ',
};

const $ = <T extends HTMLElement = HTMLElement>(id: string): T | null =>
  document.getElementById(id) as T | null;

let settings: Settings = { ...DEFAULT_SETTINGS };

// ---------- save feedback ----------

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function showSavedToast(): void {
  const toast = $('saved-toast');
  if (!toast) return;
  toast.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 1400);
}

async function persist(patch: Partial<Settings>): Promise<void> {
  try {
    settings = await setSettings(patch);
    showSavedToast();
  } catch (err) {
    log.warn('[VDL options] save failed', err);
  }
}

// ---------- render ----------

function renderTemplates(): void {
  const host = $('templates');
  if (!host) return;
  host.innerHTML = ADAPTER_INFO.map(({ id, label }) => {
    const value = settings.filenameTemplates[id] ?? '';
    const placeholder = FILENAME_TEMPLATE_DEFAULTS[id] ?? FILENAME_TEMPLATE_DEFAULTS.default;
    return `
      <div class="field template-field">
        <label for="tpl-${id}">${escapeHtml(label)}</label>
        <input id="tpl-${id}" class="tpl-input" data-adapter="${escapeHtml(id)}"
               type="text" autocomplete="off" spellcheck="false"
               value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" />
        <p class="preview" id="tpl-preview-${id}"></p>
      </div>`;
  }).join('');
  for (const { id } of ADAPTER_INFO) updateTemplatePreview(id);
}

function updateTemplatePreview(adapterId: string): void {
  const preview = $(`tpl-preview-${adapterId}`);
  if (!preview) return;
  const template = filenameTemplateFor(settings, adapterId);
  const rendered = renderFilenameTemplate(template, SAMPLE_VARS) || 'video';
  preview.textContent = `Example: ${rendered}.mp4`;
}

function renderAdapters(): void {
  const host = $('adapters');
  if (!host) return;
  host.innerHTML = ADAPTER_INFO.map(({ id, label }) => {
    const enabled = settings.adapterEnabled[id] !== false;
    return `
      <label class="toggle-row">
        <input type="checkbox" class="adapter-toggle" data-adapter="${escapeHtml(id)}"
               ${enabled ? 'checked' : ''} />
        <span>${escapeHtml(label)}</span>
      </label>`;
  }).join('');
}

function renderBlockList(): void {
  const host = $('block-list');
  if (!host) return;
  if (settings.blockedOrigins.length === 0) {
    host.innerHTML = '<li class="block-empty">No blocked origins.</li>';
    return;
  }
  host.innerHTML = settings.blockedOrigins
    .map(
      (h) => `
      <li class="block-item">
        <span>${escapeHtml(h)}</span>
        <button type="button" class="block-remove" data-host="${escapeHtml(h)}" aria-label="Remove">
          &#x2715;
        </button>
      </li>`,
    )
    .join('');
}

function renderAll(): void {
  const q = $<HTMLSelectElement>('default-quality');
  if (q) q.value = settings.defaultQuality;

  const conc = $<HTMLInputElement>('concurrency');
  const concOut = $('concurrency-out');
  if (conc) conc.value = String(settings.concurrency);
  if (concOut) concOut.textContent = String(settings.concurrency);

  renderTemplates();
  renderAdapters();
  renderBlockList();
}

// ---------- wiring ----------

function wireDownloads(): void {
  $<HTMLSelectElement>('default-quality')?.addEventListener('change', (e) => {
    // Setting an explicit default clears the sticky last-picked quality so
    // the chosen default actually takes effect on the next video.
    void setLastQualityHeight(null);
    void persist({ defaultQuality: (e.target as HTMLSelectElement).value as DefaultQuality });
  });

  const conc = $<HTMLInputElement>('concurrency');
  const concOut = $('concurrency-out');
  conc?.addEventListener('input', () => {
    if (concOut) concOut.textContent = conc.value;
  });
  conc?.addEventListener('change', () => {
    void persist({ concurrency: Number(conc.value) });
  });
}

function wireTemplates(): void {
  const host = $('templates');
  host?.addEventListener('input', (e) => {
    const input = e.target as HTMLInputElement;
    if (!input.classList.contains('tpl-input')) return;
    const adapterId = input.dataset.adapter;
    if (!adapterId) return;
    // Live preview reads the in-flight value without persisting yet.
    const live = { ...settings, filenameTemplates: { ...settings.filenameTemplates } };
    if (input.value.trim()) live.filenameTemplates[adapterId] = input.value;
    else delete live.filenameTemplates[adapterId];
    const tmpl = filenameTemplateFor(live, adapterId);
    const preview = $(`tpl-preview-${adapterId}`);
    if (preview) {
      preview.textContent = `Example: ${renderFilenameTemplate(tmpl, SAMPLE_VARS) || 'video'}.mp4`;
    }
  });
  host?.addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    if (!input.classList.contains('tpl-input')) return;
    const adapterId = input.dataset.adapter;
    if (!adapterId) return;
    const next = { ...settings.filenameTemplates };
    if (input.value.trim()) next[adapterId] = input.value.trim();
    else delete next[adapterId];
    void persist({ filenameTemplates: next });
  });
}

function wireAdapters(): void {
  $('adapters')?.addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    if (!input.classList.contains('adapter-toggle')) return;
    const adapterId = input.dataset.adapter;
    if (!adapterId) return;
    void persist({ adapterEnabled: { ...settings.adapterEnabled, [adapterId]: input.checked } });
  });
}

function wireBlockList(): void {
  const input = $<HTMLInputElement>('block-input');
  const addBtn = $('block-add-btn');
  const add = (): void => {
    const host = normalizeHost(input?.value ?? '');
    if (!host) return;
    if (settings.blockedOrigins.includes(host)) {
      if (input) input.value = '';
      return;
    }
    void persist({ blockedOrigins: [...settings.blockedOrigins, host] }).then(renderBlockList);
    if (input) input.value = '';
  };
  addBtn?.addEventListener('click', add);
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      add();
    }
  });
  $('block-list')?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('.block-remove');
    if (!btn) return;
    const host = btn.dataset.host;
    if (!host) return;
    void persist({
      blockedOrigins: settings.blockedOrigins.filter((h) => h !== host),
    }).then(renderBlockList);
  });
}

function wireData(): void {
  $('clear-captured')?.addEventListener('click', () => {
    chrome.runtime
      .sendMessage({ type: MSG.CLEAR_ALL_CAPTURED, payload: {} })
      .then(() => showSavedToast())
      .catch((err) => log.warn('[VDL options] clear captured failed', err));
  });

  $('reset-settings')?.addEventListener('click', () => {
    if (!confirm('Reset all settings to their defaults?')) return;
    // setSettings merges over current; DEFAULT_SETTINGS covers every key,
    // so this overwrites the lot. Also drop the sticky last-picked quality.
    void setLastQualityHeight(null);
    void persist({ ...DEFAULT_SETTINGS }).then(renderAll);
  });
}

// ---------- bootstrap ----------

(async () => {
  const ver = $('ext-version');
  if (ver) {
    try {
      ver.textContent = `v${chrome.runtime.getManifest().version}`;
    } catch {
      /* not in extension context */
    }
  }
  settings = await getSettings();
  renderAll();
  wireDownloads();
  wireTemplates();
  wireAdapters();
  wireBlockList();
  wireData();
})();
