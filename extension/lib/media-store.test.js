import { beforeEach, describe, it, expect, vi } from 'vitest';

let store;
let backing;

beforeEach(async () => {
  backing = {};
  globalThis.chrome = {
    storage: {
      session: {
        get: vi.fn(async (keys) => {
          const k = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const key of k) if (key in backing) out[key] = backing[key];
          return out;
        }),
        set: vi.fn(async (obj) => {
          Object.assign(backing, obj);
        }),
      },
      onChanged: { addListener: () => {} },
    },
  };
  // Fresh module state per test (Maps + initPromise are module-level).
  vi.resetModules();
  store = await import('./media-store.js');
});

describe('addEntry', () => {
  it('stores a new entry with a UUID id', async () => {
    const e = await store.addEntry(42, { url: 'https://x.com/a.m3u8', kind: 'hls' });
    expect(e).not.toBeNull();
    expect(e.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(e.url).toBe('https://x.com/a.m3u8');
    expect(e.kind).toBe('hls');
  });

  it('returns null when the same URL is added twice to the same tab', async () => {
    await store.addEntry(42, { url: 'https://x.com/a.m3u8' });
    const dup = await store.addEntry(42, { url: 'https://x.com/a.m3u8' });
    expect(dup).toBeNull();
  });

  it('allows the same URL across different tabs', async () => {
    const a = await store.addEntry(42, { url: 'https://x.com/a.m3u8' });
    const b = await store.addEntry(43, { url: 'https://x.com/a.m3u8' });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a.id).not.toBe(b.id);
  });

  it('persists to chrome.storage.session', async () => {
    await store.addEntry(42, { url: 'https://x.com/a.m3u8' });
    expect(backing.mediaState).toBeDefined();
    expect(backing.mediaState[42].entries).toHaveLength(1);
    expect(backing.mediaState[42].entries[0].url).toBe('https://x.com/a.m3u8');
  });

  it('seeds pageUrl from the tab-URL cache when the tab is new', async () => {
    await store.setTabUrl(42, 'https://hotmart.com/club/x');
    const e = await store.addEntry(42, { url: 'https://x.com/a.m3u8' });
    expect(e).not.toBeNull();
    const s = await store.getTabState(42);
    expect(s.pageUrl).toBe('https://hotmart.com/club/x');
  });
});

describe('clearTab', () => {
  it('returns true when the tab had entries, false otherwise', async () => {
    await store.addEntry(42, { url: 'https://x.com/a.m3u8' });
    expect(await store.clearTab(42)).toBe(true);
    expect(await store.clearTab(42)).toBe(false);
  });

  it('does not clear the tab-URL cache', async () => {
    await store.setTabUrl(42, 'https://x.com');
    await store.addEntry(42, { url: 'https://x.com/a.m3u8' });
    await store.clearTab(42);
    expect(await store.getTabUrl(42)).toBe('https://x.com');
  });
});

describe('setTabUrl', () => {
  it('returns { prev: undefined, current } the first time', async () => {
    expect(await store.setTabUrl(42, 'https://x.com')).toEqual({
      prev: undefined,
      current: 'https://x.com',
    });
  });

  it('returns the previous URL on subsequent calls', async () => {
    await store.setTabUrl(42, 'https://x.com');
    expect(await store.setTabUrl(42, 'https://y.com')).toEqual({
      prev: 'https://x.com',
      current: 'https://y.com',
    });
  });

  it('updates pageUrl on the existing tab state so future entries inherit it', async () => {
    await store.addEntry(42, { url: 'https://x.com/a.m3u8' });
    await store.setTabUrl(42, 'https://new.com');
    const s = await store.getTabState(42);
    expect(s.pageUrl).toBe('https://new.com');
  });
});

describe('removeTab', () => {
  it('clears both entries and the tab-URL cache', async () => {
    await store.setTabUrl(42, 'https://x.com');
    await store.addEntry(42, { url: 'https://x.com/a.m3u8' });
    await store.removeTab(42);
    expect(await store.getTabUrl(42)).toBe('');
    expect(await store.getTabEntries(42)).toEqual([]);
  });
});

describe('setAdapterMeta', () => {
  it('stores meta on a tab with no prior state', async () => {
    const { changed } = await store.setAdapterMeta(42, 'hotmart', { lessonTitle: 'Lição 3' });
    expect(changed).toBe(false); // no entries to patch yet
    expect(await store.getAdapterMeta(42, 'hotmart')).toEqual({ lessonTitle: 'Lição 3' });
  });

  it('back-patches existing entries with matching adapterId', async () => {
    await store.addEntry(42, { url: 'https://x/1.m3u8', adapterId: 'hotmart' });
    await store.addEntry(42, { url: 'https://x/2.m3u8', adapterId: 'hotmart' });
    const { changed } = await store.setAdapterMeta(42, 'hotmart', { sectionTitle: 'Porta' });
    expect(changed).toBe(true);
    const entries = await store.getTabEntries(42);
    expect(entries[0].meta).toEqual({ sectionTitle: 'Porta' });
    expect(entries[1].meta).toEqual({ sectionTitle: 'Porta' });
  });

  it('does not patch entries with a different adapterId', async () => {
    await store.addEntry(42, { url: 'https://x/1.m3u8', adapterId: 'default' });
    await store.setAdapterMeta(42, 'hotmart', { lessonTitle: 'foo' });
    const entries = await store.getTabEntries(42);
    expect(entries[0].meta).toBeUndefined();
  });

  it('merges over prior meta keys on the same adapter', async () => {
    await store.addEntry(42, { url: 'https://x/1.m3u8', adapterId: 'hotmart' });
    await store.setAdapterMeta(42, 'hotmart', { lessonTitle: 'L1', sectionTitle: 'S1' });
    await store.setAdapterMeta(42, 'hotmart', { lessonTitle: 'L2' });
    const entries = await store.getTabEntries(42);
    expect(entries[0].meta).toEqual({ lessonTitle: 'L2', sectionTitle: 'S1' });
  });
});

describe('addEntry meta inheritance', () => {
  it('inherits adapterMeta at insertion time', async () => {
    await store.setAdapterMeta(42, 'hotmart', { lessonTitle: 'Lição 5' });
    const e = await store.addEntry(42, { url: 'https://x/1.m3u8', adapterId: 'hotmart' });
    expect(e.meta).toEqual({ lessonTitle: 'Lição 5' });
  });

  it('does not inherit from a different adapter', async () => {
    await store.setAdapterMeta(42, 'hotmart', { lessonTitle: 'Lição 5' });
    const e = await store.addEntry(42, { url: 'https://x/1.m3u8', adapterId: 'default' });
    expect(e.meta).toBeUndefined();
  });
});

describe('clearTab keeps adapterMeta', () => {
  it('drops entries but preserves per-adapter meta on the tab', async () => {
    await store.setAdapterMeta(42, 'hotmart', { lessonTitle: 'Lição 5' });
    await store.addEntry(42, { url: 'https://x/1.m3u8', adapterId: 'hotmart' });
    await store.clearTab(42);
    expect(await store.getTabEntries(42)).toEqual([]);
    expect(await store.getAdapterMeta(42, 'hotmart')).toEqual({ lessonTitle: 'Lição 5' });
  });

  it('entries added after clearTab inherit the surviving meta', async () => {
    await store.setAdapterMeta(42, 'hotmart', { lessonTitle: 'Lição 5' });
    await store.clearTab(42);
    const e = await store.addEntry(42, { url: 'https://x/1.m3u8', adapterId: 'hotmart' });
    expect(e.meta).toEqual({ lessonTitle: 'Lição 5' });
  });
});
