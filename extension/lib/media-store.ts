// Per-tab MediaEntry store. Authoritative in the SW; mirrored to
// chrome.storage.session so it survives SW respawn within the same browser
// session. Not exposed directly — SW reads/writes via these helpers and
// notifies the popup via TAB_STATE_UPDATED messages.

import type { MediaEntry, PageMeta } from './types.ts';

interface TabState {
  entries: MediaEntry[];
  pageUrl: string;
  adapterMeta: Record<string, PageMeta>;
}

const tabState = new Map<number, TabState>();
const tabUrls = new Map<number, string>();

let initPromise: Promise<void> | null = null;

function nextId(): string {
  // SW context exposes crypto.randomUUID — globally unique, survives SW
  // respawns without needing the seq counter we used before.
  return crypto.randomUUID();
}

function emptyState(tabId: number): TabState {
  return { entries: [], pageUrl: tabUrls.get(tabId) ?? '', adapterMeta: {} };
}

async function init(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      const got = await chrome.storage.session.get(['mediaState', 'tabUrls']);
      if (got.mediaState) {
        for (const [k, v] of Object.entries(got.mediaState as Record<string, TabState>)) {
          // Backfill adapterMeta on older stored states (pre-v0.3).
          if (!v.adapterMeta) v.adapterMeta = {};
          tabState.set(Number(k), v);
        }
      }
      if (got.tabUrls) {
        for (const [k, v] of Object.entries(got.tabUrls as Record<string, string>)) {
          tabUrls.set(Number(k), v);
        }
      }
    } catch {
      // session storage unavailable — accept empty state
    }
  })();
  return initPromise;
}

async function persist(): Promise<void> {
  try {
    const mediaState: Record<number, TabState> = {};
    for (const [k, v] of tabState.entries()) mediaState[k] = v;
    const tabUrlsObj: Record<number, string> = {};
    for (const [k, v] of tabUrls.entries()) tabUrlsObj[k] = v;
    await chrome.storage.session.set({ mediaState, tabUrls: tabUrlsObj });
  } catch {
    // session storage might be momentarily unavailable; not fatal
  }
}

export async function ready(): Promise<void> {
  await init();
}

export async function getTabState(tabId: number): Promise<TabState> {
  await init();
  return tabState.get(tabId) ?? emptyState(tabId);
}

export async function getTabEntries(tabId: number): Promise<MediaEntry[]> {
  const s = await getTabState(tabId);
  return s.entries;
}

export async function addEntry(
  tabId: number,
  entry: Omit<MediaEntry, 'id'>,
): Promise<MediaEntry | null> {
  await init();
  let s = tabState.get(tabId);
  if (!s) {
    s = emptyState(tabId);
    tabState.set(tabId, s);
  }
  if (s.entries.some((e) => e.url === entry.url)) return null;
  // Inherit any meta the adapter has already published for this tab — so an
  // entry that lands after PAGE_META immediately has its lesson title etc.
  const inherited = s.adapterMeta?.[entry.adapterId];
  const stored: MediaEntry = {
    id: nextId(),
    ...entry,
    ...(inherited ? { meta: inherited } : {}),
  };
  s.entries.push(stored);
  await persist();
  return stored;
}

function shallowEqualMeta(a: PageMeta | undefined, b: PageMeta | undefined): boolean {
  if (!a || !b) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if ((a as Record<string, unknown>)[k] !== (b as Record<string, unknown>)[k]) return false;
  }
  return true;
}

export async function patchEntry(
  tabId: number,
  mediaId: string,
  patch: Partial<MediaEntry>,
): Promise<MediaEntry | null> {
  await init();
  const s = tabState.get(tabId);
  if (!s) return null;
  const entry = s.entries.find((e) => e.id === mediaId);
  if (!entry) return null;
  Object.assign(entry, patch);
  await persist();
  return entry;
}

export async function setAdapterMeta(
  tabId: number,
  adapterId: string,
  meta: PageMeta,
): Promise<{ changed: boolean }> {
  await init();
  let s = tabState.get(tabId);
  if (!s) {
    s = emptyState(tabId);
    tabState.set(tabId, s);
  }
  if (!s.adapterMeta) s.adapterMeta = {};
  // No-op early when the scraper produced the exact same meta as before.
  // Avoids redundant chrome.storage.session writes and TAB_STATE_UPDATED
  // broadcasts on every Hotmart re-render that doesn't actually change
  // anything we care about.
  if (shallowEqualMeta(s.adapterMeta[adapterId], meta)) {
    return { changed: false };
  }
  s.adapterMeta[adapterId] = meta;
  // Back-patch existing entries with matching adapterId — the popup may
  // already be rendering their rows.
  for (const e of s.entries) {
    if (e.adapterId === adapterId) {
      e.meta = { ...(e.meta ?? {}), ...meta };
    }
  }
  await persist();
  return { changed: true };
}

export async function getAdapterMeta(tabId: number, adapterId: string): Promise<PageMeta | null> {
  await init();
  return tabState.get(tabId)?.adapterMeta?.[adapterId] ?? null;
}

export async function setTabUrl(
  tabId: number,
  url: string,
): Promise<{ prev: string | undefined; current: string }> {
  await init();
  const prev = tabUrls.get(tabId);
  tabUrls.set(tabId, url);
  // Update pageUrl on the existing state too (so future entries inherit it).
  const s = tabState.get(tabId);
  if (s) s.pageUrl = url;
  await persist();
  return { prev, current: url };
}

export async function clearTab(tabId: number): Promise<boolean> {
  await init();
  const s = tabState.get(tabId);
  const had = s != null && s.entries.length > 0;
  if (s) {
    s.entries = [];
    // Intentionally KEEP adapterMeta. clearTab fires on every URL change
    // (incl. trivial ones like Hotmart's pt-br → pt-BR case-normalization)
    // that don't trigger a DOM mutation — so the page-content observer will
    // NOT re-send PAGE_META, and wiping adapterMeta here would leave the
    // entries that arrive next without their lesson title etc.
    // On real navigation between lessons, the observer fires within ~250ms
    // and overwrites this stale meta via setAdapterMeta (which also
    // back-patches the briefly-stale entries).
  }
  await persist();
  return had;
}

export async function removeTab(tabId: number): Promise<void> {
  await init();
  tabState.delete(tabId);
  tabUrls.delete(tabId);
  await persist();
}

// Forget every tab's detected entries AND adapterMeta (captured page
// metadata / header context). Used by the options page "Clear all
// captured auth/header state" button. Returns the tabIds that had
// state so the caller can refresh their badges + push empty popups.
// tabUrls are kept so navigation tracking still works.
export async function clearAll(): Promise<number[]> {
  await init();
  const affected = [...tabState.keys()];
  tabState.clear();
  await persist();
  return affected;
}

export async function getTabUrl(tabId: number): Promise<string> {
  await init();
  return tabUrls.get(tabId) ?? '';
}
