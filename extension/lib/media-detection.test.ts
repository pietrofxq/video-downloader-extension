import { describe, it, expect } from 'vitest';
import { classifyUrl, isPrimary, KINDS } from './media-detection.js';

describe('classifyUrl', () => {
  it('detects HLS from .m3u8 extension', () => {
    expect(classifyUrl('https://x.com/a/b.m3u8')).toBe(KINDS.HLS);
    expect(classifyUrl('https://x.com/a/b.m3u8?token=abc&exp=999')).toBe(KINDS.HLS);
  });

  it('detects DASH from .mpd extension', () => {
    expect(classifyUrl('https://x.com/manifest.mpd')).toBe(KINDS.DASH);
  });

  it('detects progressive MP4 / WebM', () => {
    expect(classifyUrl('https://x.com/v.mp4')).toBe(KINDS.PROGRESSIVE);
    expect(classifyUrl('https://x.com/v.webm')).toBe(KINDS.PROGRESSIVE);
  });

  it('detects HLS/DASH segments', () => {
    expect(classifyUrl('https://x.com/seg-0001.ts')).toBe(KINDS.SEGMENT);
    expect(classifyUrl('https://x.com/seg-0001.m4s')).toBe(KINDS.SEGMENT);
  });

  it('detects key files', () => {
    expect(classifyUrl('https://x.com/aes.key')).toBe(KINDS.KEY);
  });

  it('returns null for unrelated URLs', () => {
    expect(classifyUrl('https://x.com/index.html')).toBeNull();
    expect(classifyUrl('https://x.com/api/data.json')).toBeNull();
    expect(classifyUrl('https://x.com/')).toBeNull();
  });

  it('uses Content-Type fallback when extension is missing', () => {
    expect(classifyUrl('https://x.com/play', 'application/vnd.apple.mpegurl')).toBe(KINDS.HLS);
    expect(classifyUrl('https://x.com/play', 'application/dash+xml')).toBe(KINDS.DASH);
    expect(classifyUrl('https://x.com/play', 'video/mp4')).toBe(KINDS.PROGRESSIVE);
  });

  it('extension wins over Content-Type', () => {
    expect(classifyUrl('https://x.com/a.m3u8', 'video/mp4')).toBe(KINDS.HLS);
  });

  it('handles malformed URLs without throwing', () => {
    expect(classifyUrl('not a url')).toBeNull();
    expect(classifyUrl('')).toBeNull();
  });

  it('is case-insensitive on extensions', () => {
    expect(classifyUrl('https://x.com/A/B.M3U8')).toBe(KINDS.HLS);
  });

  it('does not false-positive on extension-in-the-middle', () => {
    // Path segments: /metakeys.json/  → ext is .json, not .key
    expect(classifyUrl('https://x.com/metakeys.json')).toBeNull();
  });
});

describe('isPrimary', () => {
  it('flags HLS / DASH / progressive', () => {
    expect(isPrimary(KINDS.HLS)).toBe(true);
    expect(isPrimary(KINDS.DASH)).toBe(true);
    expect(isPrimary(KINDS.PROGRESSIVE)).toBe(true);
  });
  it('rejects segment / key', () => {
    expect(isPrimary(KINDS.SEGMENT)).toBe(false);
    expect(isPrimary(KINDS.KEY)).toBe(false);
  });
});
