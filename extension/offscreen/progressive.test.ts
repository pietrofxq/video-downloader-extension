import { describe, it, expect } from 'vitest';
import { deriveProgressiveExtension } from './progressive.js';

describe('deriveProgressiveExtension', () => {
  describe('YouTube videoplayback URLs (mime query param)', () => {
    const yt = (mime: string): string =>
      `https://rr3---sn-xyz.googlevideo.com/videoplayback?itag=18&mime=${encodeURIComponent(mime)}`;

    it('returns mp4 for video/mp4', () => {
      expect(deriveProgressiveExtension(yt('video/mp4'))).toBe('mp4');
    });

    it('returns webm for video/webm', () => {
      expect(deriveProgressiveExtension(yt('video/webm'))).toBe('webm');
    });

    it('returns 3gp for video/3gpp (itag=36)', () => {
      expect(deriveProgressiveExtension(yt('video/3gpp'))).toBe('3gp');
    });
  });

  describe('generic progressive URLs (path extension)', () => {
    it('picks up .mp4 from path', () => {
      expect(deriveProgressiveExtension('https://example.com/video.mp4')).toBe('mp4');
    });

    it('picks up .webm from path', () => {
      expect(deriveProgressiveExtension('https://example.com/clip.webm')).toBe('webm');
    });

    it('picks up .3gp from path', () => {
      expect(deriveProgressiveExtension('https://example.com/clip.3gp')).toBe('3gp');
    });

    it('normalizes .m4v to mp4 (same container)', () => {
      expect(deriveProgressiveExtension('https://example.com/clip.m4v')).toBe('mp4');
    });

    it('ignores unrecognized path extensions', () => {
      // We don't want to mis-trust something like .bin or .txt.
      expect(deriveProgressiveExtension('https://example.com/file.bin')).toBe('mp4');
    });

    it('is case-insensitive on the path extension', () => {
      expect(deriveProgressiveExtension('https://example.com/clip.WEBM')).toBe('webm');
    });
  });

  describe('mime query param wins over path extension', () => {
    // YouTube path is /videoplayback (no useful extension); mime= is
    // the source of truth.
    it('mime=video/webm beats a .mp4 in the path', () => {
      const url =
        'https://rr3---sn-xyz.googlevideo.com/videoplayback.mp4?mime=video%2Fwebm&itag=251';
      expect(deriveProgressiveExtension(url)).toBe('webm');
    });
  });

  describe('fallbacks', () => {
    it('defaults to mp4 when neither mime nor extension is helpful', () => {
      expect(deriveProgressiveExtension('https://example.com/play')).toBe('mp4');
    });

    it('defaults to mp4 on a malformed URL', () => {
      expect(deriveProgressiveExtension('not a url')).toBe('mp4');
    });
  });
});
