import { describe, it, expect } from 'vitest';
import { pickAdapter, getAdapter, ADAPTERS } from './index.js';
import hotmart from './hotmart.js';
import defaultAdapter from './default.js';

describe('pickAdapter', () => {
  it('picks hotmart on hotmart.com club lessons', () => {
    expect(pickAdapter('https://hotmart.com/abc/club/123', '').id).toBe('hotmart');
    expect(pickAdapter('https://app.hotmart.com/abc/club/123', '').id).toBe('hotmart');
  });

  it('falls back to default on non-club hotmart pages', () => {
    expect(pickAdapter('https://hotmart.com/abc/sales', '').id).toBe('default');
    expect(pickAdapter('https://hotmart.com/', '').id).toBe('default');
  });

  it('does not match imposter hosts ending in hotmart.com', () => {
    expect(pickAdapter('https://evilhotmart.com/x/club/1', '').id).toBe('default');
    expect(pickAdapter('https://not-hotmart.com/x/club/1', '').id).toBe('default');
  });

  it('default adapter matches any URL as fallback', () => {
    expect(pickAdapter('https://example.com/anything', '').id).toBe('default');
    expect(pickAdapter('', '').id).toBe('default');
  });

  it('falls back to default when pageUrl is empty, regardless of mediaUrl', () => {
    // If handleDetection ever reaches pickAdapter without a resolved pageUrl
    // (e.g. SW startup race), we intentionally fall back to default — adapter
    // selection is keyed on the page, not the media URL. The seedTabs() await
    // in the SW is what prevents this from happening on real Hotmart pages.
    expect(pickAdapter('', 'https://vod-akm.play.hotmart.com/video/x.m3u8').id).toBe('default');
  });
});

describe('getAdapter', () => {
  it('returns the named adapter when registered', () => {
    expect(getAdapter('hotmart')).toBe(hotmart);
    expect(getAdapter('default')).toBe(defaultAdapter);
  });
  it('returns default for unknown ids', () => {
    expect(getAdapter('unknown-site')).toBe(defaultAdapter);
  });
});

describe('ADAPTERS ordering', () => {
  it('lists specific adapters before the default fallback', () => {
    const idx = ADAPTERS.findIndex((a) => a.id === 'default');
    expect(idx).toBe(ADAPTERS.length - 1);
  });
});

describe('default.deriveFilename', () => {
  it('sanitizes title with illegal chars', () => {
    const name = defaultAdapter.deriveFilename({
      pageMeta: { title: 'Hello / World : Best?' },
      url: 'https://x.com/path/video.mp4',
    });
    expect(name).not.toMatch(/[/:?]/);
    expect(name).toContain('video');
  });

  it('falls back to URL basename when title missing', () => {
    const name = defaultAdapter.deriveFilename({
      pageMeta: { title: '' },
      url: 'https://x.com/path/clip.mp4',
    });
    expect(name).toBe('clip');
  });
});

describe('hotmart.deriveFilename', () => {
  it('formats as "{section} - {lesson}" when both present', () => {
    expect(
      hotmart.deriveFilename({
        url: '',
        pageMeta: { sectionTitle: 'Porta de Entrada', lessonTitle: 'Lição 3' },
      }),
    ).toBe('Porta de Entrada - Lição 3');
  });

  it('falls back to lesson, then title, then literal', () => {
    expect(hotmart.deriveFilename({ url: '', pageMeta: { lessonTitle: 'Lição 1' } })).toBe(
      'Lição 1',
    );
    expect(hotmart.deriveFilename({ url: '', pageMeta: { title: 'just-a-title' } })).toBe(
      'just-a-title',
    );
    expect(hotmart.deriveFilename({ url: '', pageMeta: {} })).toBe('hotmart-lesson');
  });

  it('sanitizes illegal chars in lesson titles', () => {
    const name = hotmart.deriveFilename({
      url: '',
      pageMeta: { sectionTitle: 'a/b', lessonTitle: 'c:d' },
    });
    expect(name).not.toMatch(/[/:]/);
  });
});
