// Per-tab MediaEntry store. Authoritative in the SW; mirrored to
// chrome.storage.session so it survives SW respawn within the same browser
// session. Not exposed directly — SW reads/writes via these helpers and
// notifies the popup via TAB_STATE_UPDATED messages.

const tabState = new Map(); // tabId -> { entries: MediaEntry[], pageUrl: string, adapterMeta: Record<adapterId, PageMeta> }
const tabUrls = new Map(); // tabId -> last known url (used to detect navigation)

let initPromise = null;

function nextId() {
  // SW context exposes crypto.randomUUID — globally unique, survives SW
  // respawns without needing the seq counter we used before.
  return crypto.randomUUID();
}

function emptyState(tabId) {
  return { entries: [], pageUrl: tabUrls.get(tabId) ?? '', adapterMeta: {} };
}

async function init() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      const got = await chrome.storage.session.get(['mediaState', 'tabUrls']);
      if (got.mediaState) {
        for (const [k, v] of Object.entries(got.mediaState)) {
          // Backfill adapterMeta on older stored states (pre-v0.3).
          if (!v.adapterMeta) v.adapterMeta = {};
          tabState.set(Number(k), v);
        }
      }
      if (got.tabUrls) {
        for (const [k, v] of Object.entries(got.tabUrls)) tabUrls.set(Number(k), v);
      }
    } catch {
      // session storage unavailable — accept empty state
    }
  })();
  return initPromise;
}

async function persist() {
  try {
    const mediaState = {};
    for (const [k, v] of tabState.entries()) mediaState[k] = v;
    const tabUrlsObj = {};
    for (const [k, v] of tabUrls.entries()) tabUrlsObj[k] = v;
    await chrome.storage.session.set({ mediaState, tabUrls: tabUrlsObj });
  } catch {
    // session storage might be momentarily unavailable; not fatal
  }
}

export async function ready() {
  await init();
}

export async function getTabState(tabId) {
  await init();
  return tabState.get(tabId) ?? emptyState(tabId);
}

export async function getTabEntries(tabId) {
  const s = await getTabState(tabId);
  return s.entries;
}

export async function addEntry(tabId, entry) {
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
  const stored = { id: nextId(), ...entry, ...(inherited ? { meta: inherited } : {}) };
  s.entries.push(stored);
  await persist();
  return stored;
}

function shallowEqualMeta(a, b) {
  if (!a || !b) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
}

export async function setAdapterMeta(tabId, adapterId, meta) {
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

export async function getAdapterMeta(tabId, adapterId) {
  await init();
  return tabState.get(tabId)?.adapterMeta?.[adapterId] ?? null;
}

export async function setTabUrl(tabId, url) {
  await init();
  const prev = tabUrls.get(tabId);
  tabUrls.set(tabId, url);
  // Update pageUrl on the existing state too (so future entries inherit it).
  const s = tabState.get(tabId);
  if (s) s.pageUrl = url;
  await persist();
  return { prev, current: url };
}

export async function clearTab(tabId) {
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

export async function removeTab(tabId) {
  await init();
  tabState.delete(tabId);
  tabUrls.delete(tabId);
  await persist();
}

export async function getTabUrl(tabId) {
  await init();
  return tabUrls.get(tabId) ?? '';
}
