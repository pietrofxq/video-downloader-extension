import { describe, it, expect } from 'vitest';
import { redactUrl } from './log.js';

const SENSITIVE_PARAMS = [
  'hdntl',
  'hdnts',
  'token',
  'signature',
  'sig',
  'policy',
  'key-pair-id',
  'x-amz-signature',
  'x-amz-security-token',
  'auth',
  'auth_token',
  'authorization',
  'bearer',
  'jwt',
  'jwttoken',
  'exp',
  'expires',
  'nonce',
];

describe('redactUrl', () => {
  it('redacts every sensitive param in REDACTED_PARAMS', () => {
    for (const p of SENSITIVE_PARAMS) {
      const url = `https://x.com/a?${p}=supersecret&app=visible`;
      const redacted = redactUrl(url);
      expect(redacted, `param '${p}' should be redacted`).toContain(`${p}=__REDACTED__`);
      expect(redacted, `param '${p}' should not leak value`).not.toContain('supersecret');
      expect(redacted).toContain('app=visible');
    }
  });

  it('is case-insensitive on param names', () => {
    expect(redactUrl('https://x.com/a?HDNTL=secret')).toContain('HDNTL=__REDACTED__');
    expect(redactUrl('https://x.com/a?Hdntl=secret')).toContain('Hdntl=__REDACTED__');
  });

  it('leaves unrelated params alone (no-mutation pass-through)', () => {
    const url = 'https://x.com/a?app=visible&id=alsovisible';
    expect(redactUrl(url)).toBe(url);
  });

  it('returns input unchanged for malformed URLs', () => {
    expect(redactUrl('not a url')).toBe('not a url');
    expect(redactUrl('')).toBe('');
    expect(redactUrl(null)).toBe(null);
  });

  it('redacts a hotmart-shaped signed URL completely', () => {
    const url =
      'https://vod-akm.play.hotmart.com/video/QZp5V39GR6/hls/QZp5V39GR6-1700000000.m3u8' +
      '?hdntl=exp=1700000000~acl=/video/*~hmac=58858d52deadbeef' +
      '&app=2650a7b0-ae0d-454a-8874-592b9713a9be';
    const redacted = redactUrl(url);
    expect(redacted).toContain('hdntl=__REDACTED__');
    expect(redacted).not.toContain('58858d52');
    expect(redacted).not.toContain('deadbeef');
    expect(redacted).not.toContain('hmac');
    expect(redacted).toContain('app=2650a7b0-ae0d-454a-8874-592b9713a9be');
  });

  it('redacts multiple sensitive params in the same URL', () => {
    const url = 'https://x.com/a?hdntl=t1&signature=t2&app=visible';
    const redacted = redactUrl(url);
    expect(redacted).toContain('hdntl=__REDACTED__');
    expect(redacted).toContain('signature=__REDACTED__');
    expect(redacted).toContain('app=visible');
    expect(redacted).not.toContain('t1');
    expect(redacted).not.toContain('t2');
  });
});
