import { describe, it, expect } from 'vitest';
import { urlExpiresAt, isUrlExpired } from './url-expiry.js';

const NOW = 1_786_000_000_000; // 2026-08-06T…Z, epoch ms
const NOW_S = NOW / 1000;

describe('urlExpiresAt', () => {
  it('reads YouTube’s `expire` param as epoch seconds', () => {
    expect(urlExpiresAt(`https://x.googlevideo.com/videoplayback?itag=701&expire=${NOW_S}`)).toBe(
      NOW,
    );
  });

  it('reads a millisecond-scale timestamp without re-scaling it', () => {
    expect(urlExpiresAt(`https://cdn.example.com/v.mp4?expires=${NOW}`)).toBe(NOW);
  });

  it('matches the param name case-insensitively (CloudFront `Expires`)', () => {
    expect(urlExpiresAt(`https://cdn.example.com/v.mp4?Expires=${NOW_S}`)).toBe(NOW);
  });

  it('reads the `exp` field out of an Akamai hdntl token blob', () => {
    const url = `https://cdn.example.com/seg.ts?hdntl=exp=${NOW_S}~acl=/*~hmac=deadbeef`;
    expect(urlExpiresAt(url)).toBe(NOW);
  });

  it('returns null when the URL publishes no deadline', () => {
    expect(urlExpiresAt('https://x.googlevideo.com/videoplayback?itag=18&n=abc')).toBeNull();
  });

  it('returns null for a non-URL string', () => {
    expect(urlExpiresAt('not a url')).toBeNull();
  });

  it('ignores values too small to be an epoch timestamp', () => {
    // A duration, not a deadline — misreading it would mark every URL expired.
    expect(urlExpiresAt('https://cdn.example.com/v.mp4?expires=3600')).toBeNull();
  });

  it('ignores non-numeric values', () => {
    expect(urlExpiresAt('https://cdn.example.com/v.mp4?expires=soon')).toBeNull();
  });
});

describe('isUrlExpired', () => {
  it('is true once the declared deadline has passed', () => {
    expect(isUrlExpired(`https://cdn.example.com/v.mp4?expire=${NOW_S - 60}`, NOW)).toBe(true);
  });

  it('is false while the deadline is still ahead', () => {
    expect(isUrlExpired(`https://cdn.example.com/v.mp4?expire=${NOW_S + 3600}`, NOW)).toBe(false);
  });

  // The load-bearing case for the v0.12 poToken gate: YouTube hands us a
  // URL with hours left on it and the CDN 403s it anyway. Inferring
  // expiry here is what produced the bogus "Token expired" message.
  it('is false when no deadline is declared at all', () => {
    expect(isUrlExpired('https://x.googlevideo.com/videoplayback?itag=701', NOW)).toBe(false);
  });
});
