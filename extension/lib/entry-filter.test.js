import { describe, it, expect } from 'vitest';
import { filterTopLevel } from './entry-filter.js';

describe('filterTopLevel', () => {
  it('returns top-level entries when there are no list references', () => {
    const entries = [
      { id: 'a', url: 'https://a.m3u8' },
      { id: 'b', url: 'https://b.m3u8' },
    ];
    expect(filterTopLevel(entries)).toEqual(entries);
  });

  it('hides entries listed in another entry variants', () => {
    const entries = [
      { id: 'a', url: 'https://master.m3u8', variants: [{ url: 'https://720.m3u8' }] },
      { id: 'b', url: 'https://720.m3u8' },
    ];
    expect(filterTopLevel(entries)).toEqual([entries[0]]);
  });

  it('hides entries listed in another entry alternates (subtitle/alt-audio)', () => {
    const entries = [
      { id: 'a', url: 'https://master.m3u8', alternates: [{ url: 'https://subs.m3u8' }] },
      { id: 'b', url: 'https://subs.m3u8' },
    ];
    expect(filterTopLevel(entries)).toEqual([entries[0]]);
  });

  it('collapses both variants and alternates under a single master row', () => {
    const entries = [
      {
        id: 'master',
        url: 'https://master.m3u8',
        variants: [{ url: 'https://720.m3u8' }, { url: 'https://1080.m3u8' }],
        alternates: [{ url: 'https://subs.m3u8' }],
      },
      { id: 'v1', url: 'https://720.m3u8' },
      { id: 'v2', url: 'https://1080.m3u8' },
      { id: 'a1', url: 'https://subs.m3u8' },
    ];
    expect(filterTopLevel(entries).map((e) => e.id)).toEqual(['master']);
  });

  it('keeps masters whose variants are not in the list', () => {
    const entries = [
      {
        id: 'master',
        url: 'https://master.m3u8',
        variants: [{ url: 'https://720.m3u8' }],
      },
    ];
    expect(filterTopLevel(entries)).toEqual(entries);
  });

  it('handles empty input', () => {
    expect(filterTopLevel([])).toEqual([]);
    expect(filterTopLevel(null)).toEqual([]);
    expect(filterTopLevel(undefined)).toEqual([]);
  });
});
