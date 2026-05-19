// Per-tab MediaEntry store. Authoritative in the SW; mirrored to
// chrome.storage.session so it survives SW respawn within the same browser
// session. Not exposed directly — SW reads/writes via these helpers and
// notifies the popup via TAB_STATE_UPDATED messages.

const tabState = new Map(); // tabId -> { entries: MediaEntry[], pageUrl: string }
const tabUrls = new Map(); // tabId -> last known url (used to detect navigation)

let seq = 0;
let initPromise = null;

function nextId(tabId) {
  seq += 1;
  return `media-${tabId}-${Date.now().toString(36)}-${seq}`;
}

async function init() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      const got = await chrome.storage.session.get(['mediaState', 'tabUrls']);
      if (got.mediaState) {
        for (const [k, v] of Object.entries(got.mediaState)) tabState.set(Number(k), v);
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
  return tabState.get(tabId) ?? { entries: [], pageUrl: tabUrls.get(tabId) ?? '' };
}

export async function getTabEntries(tabId) {
  const s = await getTabState(tabId);
  return s.entries;
}

export async function addEntry(tabId, entry) {
  await init();
  let s = tabState.get(tabId);
  if (!s) {
    s = { entries: [], pageUrl: tabUrls.get(tabId) ?? '' };
    tabState.set(tabId, s);
  }
  if (s.entries.some((e) => e.url === entry.url)) return null;
  const stored = { id: nextId(tabId), ...entry };
  s.entries.push(stored);
  await persist();
  return stored;
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
  const had = tabState.has(tabId);
  tabState.delete(tabId);
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
