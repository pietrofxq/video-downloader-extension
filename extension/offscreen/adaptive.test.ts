import { describe, it, expect } from 'vitest';
import { contentLengthFromUrl } from './adaptive.js';

describe('contentLengthFromUrl', () => {
  it('reads googlevideo`s clen param', () => {
    expect(
      contentLengthFromUrl('https://x.googlevideo.com/videoplayback?itag=401&clen=8605351936'),
    ).toBe(8605351936);
  });

  it('returns undefined when clen is absent', () => {
    expect(
      contentLengthFromUrl('https://x.googlevideo.com/videoplayback?itag=401'),
    ).toBeUndefined();
  });

  it('returns undefined for a non-numeric or zero clen', () => {
    expect(contentLengthFromUrl('https://x/v?clen=abc')).toBeUndefined();
    expect(contentLengthFromUrl('https://x/v?clen=0')).toBeUndefined();
  });

  it('returns undefined for a malformed URL', () => {
    expect(contentLengthFromUrl('not a url')).toBeUndefined();
  });
});
