import { describe, it, expect } from 'vitest';
import { filterTopLevel } from './entry-filter.js';
import type { MediaEntry } from './types.ts';

// filterTopLevel only reads url / variants / alternates, so test fixtures
// are intentionally partial — `as MediaEntry[]` papers over the missing
// kind / pageUrl / adapterId / capturedAt fields the production shape
// requires.
// filterTopLevel only reads `.url` on variants/alternates, so this loose
// stub is enough for the test fixtures.
interface EntryStub {
  id: string;
  url: string;
  kind?: string;
  drm?: boolean;
  variants?: { url: string }[];
  alternates?: { url: string }[];
}
const asEntries = (xs: EntryStub[]): MediaEntry[] => xs as unknown as MediaEntry[];

describe('filterTopLevel', () => {
  it('returns top-level entries when there are no list references', () => {
    const entries = asEntries([
      { id: 'a', url: 'https://a.m3u8' },
      { id: 'b', url: 'https://b.m3u8' },
    ]);
    expect(filterTopLevel(entries)).toEqual(entries);
  });

  it('hides entries listed in another entry variants', () => {
    const entries = asEntries([
      { id: 'a', url: 'https://master.m3u8', variants: [{ url: 'https://720.m3u8' }] },
      { id: 'b', url: 'https://720.m3u8' },
    ]);
    expect(filterTopLevel(entries)).toEqual([entries[0]]);
  });

  it('hides entries listed in another entry alternates (subtitle/alt-audio)', () => {
    const entries = asEntries([
      { id: 'a', url: 'https://master.m3u8', alternates: [{ url: 'https://subs.m3u8' }] },
      { id: 'b', url: 'https://subs.m3u8' },
    ]);
    expect(filterTopLevel(entries)).toEqual([entries[0]]);
  });

  it('collapses both variants and alternates under a single master row', () => {
    const entries = asEntries([
      {
        id: 'master',
        url: 'https://master.m3u8',
        variants: [{ url: 'https://720.m3u8' }, { url: 'https://1080.m3u8' }],
        alternates: [{ url: 'https://subs.m3u8' }],
      },
      { id: 'v1', url: 'https://720.m3u8' },
      { id: 'v2', url: 'https://1080.m3u8' },
      { id: 'a1', url: 'https://subs.m3u8' },
    ]);
    expect(filterTopLevel(entries).map((e) => e.id)).toEqual(['master']);
  });

  it('keeps masters whose variants are not in the list', () => {
    const entries = asEntries([
      {
        id: 'master',
        url: 'https://master.m3u8',
        variants: [{ url: 'https://720.m3u8' }],
      },
    ]);
    expect(filterTopLevel(entries)).toEqual(entries);
  });

  it('handles empty input', () => {
    expect(filterTopLevel([])).toEqual([]);
    expect(filterTopLevel(null as unknown as MediaEntry[])).toEqual([]);
    expect(filterTopLevel(undefined as unknown as MediaEntry[])).toEqual([]);
  });

  it('hides passive DASH captures (no variants) — nothing can parse or download them', () => {
    // A page exposing both .m3u8 and .mpd for the same video otherwise
    // produces a second row permanently stuck on "Loading…".
    const entries = asEntries([
      { id: 'hls', url: 'https://cdn.example.com/master.m3u8', kind: 'hls' },
      { id: 'mpd', url: 'https://cdn.example.com/manifest.mpd', kind: 'dash' },
      { id: 'mpd2', url: 'https://cdn.example.com/other.mpd', kind: 'dash', variants: [] },
    ]);
    expect(filterTopLevel(entries).map((e) => e.id)).toEqual(['hls']);
  });

  it('keeps adapter-supplied DASH entries (non-empty variants) and DRM-flagged ones', () => {
    const entries = asEntries([
      {
        id: 'yt',
        url: 'youtube:abc123',
        kind: 'dash',
        variants: [{ url: 'https://r1.googlevideo.com/videoplayback?itag=137' }],
      },
      { id: 'drm', url: 'https://cdn.example.com/protected.mpd', kind: 'dash', drm: true },
    ]);
    expect(filterTopLevel(entries).map((e) => e.id)).toEqual(['yt', 'drm']);
  });

  it('keeps progressive and unparsed HLS entries', () => {
    const entries = asEntries([
      { id: 'mp4', url: 'https://cdn.example.com/clip.mp4', kind: 'progressive' },
      { id: 'hls', url: 'https://cdn.example.com/master.m3u8', kind: 'hls' },
    ]);
    expect(filterTopLevel(entries).map((e) => e.id)).toEqual(['mp4', 'hls']);
  });
});
