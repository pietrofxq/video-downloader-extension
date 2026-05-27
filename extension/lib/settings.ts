// User settings, persisted in chrome.storage.local under a single key.
//
// All reads go through getSettings(), which merges the stored blob over
// DEFAULT_SETTINGS so a partial/old/corrupt value never crashes a caller
// (settings are read on every detection + download). Writes go through
// setSettings(patch), a read-merge-write so concurrent callers updating
// different fields don't clobber each other.
//
// This module is imported from the SW, offscreen, popup, and options
// page — keep it dependency-light (only sanitize-filename, no chrome
// types beyond storage.local).

import { sanitizeFilename } from './sanitize-filename.js';

export type DefaultQuality = 'highest' | '1080p' | '720p' | '480p' | 'ask';

export interface Settings {
  /** Which quality to pre-select in the popup picker. 'ask' = no preference (highest). */
  defaultQuality: DefaultQuality;
  /** Parallel segment fetches during an HLS download. Clamped to [1, 8]. */
  concurrency: number;
  /** adapterId -> filename template (e.g. "{section} - {lesson}"). Missing = adapter default. */
  filenameTemplates: Record<string, string>;
  /** adapterId -> enabled. A missing key means enabled (opt-out, not opt-in). */
  adapterEnabled: Record<string, boolean>;
  /** Page-origin hosts where detection is silenced (exact host match). */
  blockedOrigins: string[];
}

// Per-adapter filename template defaults. The token set is documented in
// renderFilenameTemplate; unknown adapters fall back to the 'default' one.
export const FILENAME_TEMPLATE_DEFAULTS: Readonly<Record<string, string>> = {
  hotmart: '{section} - {lesson}',
  youtube: '{channel} - {title}',
  default: '{title} - {basename}',
};

export const CONCURRENCY_MIN = 1;
export const CONCURRENCY_MAX = 8;
export const CONCURRENCY_DEFAULT = 4;

export const DEFAULT_SETTINGS: Settings = {
  defaultQuality: 'highest',
  concurrency: CONCURRENCY_DEFAULT,
  filenameTemplates: {},
  adapterEnabled: {},
  blockedOrigins: [],
};

const SETTINGS_KEY = 'settings';

const DEFAULT_QUALITIES: readonly DefaultQuality[] = ['highest', '1080p', '720p', '480p', 'ask'];

function isDefaultQuality(v: unknown): v is DefaultQuality {
  return typeof v === 'string' && (DEFAULT_QUALITIES as readonly string[]).includes(v);
}

export function clampConcurrency(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : CONCURRENCY_DEFAULT;
  return Math.min(CONCURRENCY_MAX, Math.max(CONCURRENCY_MIN, v));
}

function isStringMap(v: unknown): v is Record<string, string> {
  if (!v || typeof v !== 'object') return false;
  return Object.values(v as Record<string, unknown>).every((x) => typeof x === 'string');
}

function isBoolMap(v: unknown): v is Record<string, boolean> {
  if (!v || typeof v !== 'object') return false;
  return Object.values(v as Record<string, unknown>).every((x) => typeof x === 'boolean');
}

/** Merge a raw stored value over the defaults, dropping anything malformed. */
export function normalizeSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Settings>;
  return {
    defaultQuality: isDefaultQuality(r.defaultQuality)
      ? r.defaultQuality
      : DEFAULT_SETTINGS.defaultQuality,
    concurrency: clampConcurrency(r.concurrency),
    filenameTemplates: isStringMap(r.filenameTemplates) ? { ...r.filenameTemplates } : {},
    adapterEnabled: isBoolMap(r.adapterEnabled) ? { ...r.adapterEnabled } : {},
    blockedOrigins: Array.isArray(r.blockedOrigins)
      ? r.blockedOrigins.filter((s): s is string => typeof s === 'string')
      : [],
  };
}

export async function getSettings(): Promise<Settings> {
  try {
    const got = await chrome.storage.local.get(SETTINGS_KEY);
    return normalizeSettings(got[SETTINGS_KEY]);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Read-merge-write a partial update; returns the resulting full settings. */
export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings();
  const next = normalizeSettings({ ...current, ...patch });
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

// ---------- last-picked quality (sticky picker default) ----------
//
// Distinct from the `defaultQuality` setting: this is the height the user
// last manually chose in the popup picker, remembered so the next video's
// picker pre-selects the same quality. Stored under its own key so a pick
// doesn't churn the whole settings blob. Cleared when the user changes the
// explicit defaultQuality in options, so that setting always wins fresh.
const LAST_QUALITY_KEY = 'lastQualityHeight';

export async function getLastQualityHeight(): Promise<number | null> {
  try {
    const got = await chrome.storage.local.get(LAST_QUALITY_KEY);
    const v = got[LAST_QUALITY_KEY];
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

export async function setLastQualityHeight(height: number | null): Promise<void> {
  try {
    if (height == null || !Number.isFinite(height) || height <= 0) {
      await chrome.storage.local.remove(LAST_QUALITY_KEY);
    } else {
      await chrome.storage.local.set({ [LAST_QUALITY_KEY]: Math.round(height) });
    }
  } catch {
    // best-effort; a failed remember just means no stickiness this time
  }
}

/** Subscribe to settings changes. Returns an unsubscribe function. */
export function onSettingsChanged(cb: (settings: Settings) => void): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
    if (area !== 'local' || !(SETTINGS_KEY in changes)) return;
    cb(normalizeSettings(changes[SETTINGS_KEY].newValue));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

// ---------- pure helpers (no chrome; unit-tested) ----------

/** A missing key means enabled — adapters are opt-out, not opt-in. */
export function isAdapterEnabled(settings: Settings, adapterId: string): boolean {
  return settings.adapterEnabled[adapterId] !== false;
}

/** Is detection silenced for this page URL's origin host? */
export function isOriginBlocked(settings: Settings, pageUrl: string): boolean {
  if (settings.blockedOrigins.length === 0) return false;
  const host = hostOf(pageUrl);
  if (!host) return false;
  return settings.blockedOrigins.some((b) => normalizeHost(b) === host);
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
}

/** Accept a bare host or a full URL when the user types a block-list entry. */
export function normalizeHost(input: string): string {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return '';
  const viaUrl = hostOf(trimmed) || hostOf(`https://${trimmed}`);
  return viaUrl || trimmed.replace(/^https?:\/\//, '').split('/')[0];
}

/** The effective template for an adapter: user override → adapter default → generic default. */
export function filenameTemplateFor(settings: Settings, adapterId: string): string {
  const custom = settings.filenameTemplates[adapterId];
  if (custom && custom.trim()) return custom;
  return FILENAME_TEMPLATE_DEFAULTS[adapterId] ?? FILENAME_TEMPLATE_DEFAULTS.default;
}

export interface FilenameVars {
  title?: string;
  lesson?: string;
  section?: string;
  channel?: string;
  basename?: string;
  videoId?: string;
}

/**
 * Render a filename template, substituting {token}s and tidying the
 * separators that empty tokens leave behind (e.g. a missing {section} in
 * "{section} - {lesson}" shouldn't leave a leading " - "). Returns a
 * sanitized string, or '' when nothing resolved — callers treat '' as
 * "fall back to the adapter's deriveFilename".
 */
export function renderFilenameTemplate(template: string, vars: FilenameVars): string {
  const map: Record<string, string> = {
    title: vars.title ?? '',
    lesson: vars.lesson ?? '',
    section: vars.section ?? '',
    channel: vars.channel ?? '',
    basename: vars.basename ?? '',
    videoId: vars.videoId ?? '',
  };
  const filled = template.replace(/\{(\w+)\}/g, (_m, k: string) => map[k] ?? '');
  const cleaned = filled
    // collapse "x -  - y" (dangling separator from an empty token) to "x - y"
    .replace(/(\s*[-–—]\s*){2,}/g, ' - ')
    // trim leading/trailing separators
    .replace(/^\s*[-–—]\s*/, '')
    .replace(/\s*[-–—]\s*$/, '')
    .trim();
  return sanitizeFilename(cleaned, { fallback: '' });
}
