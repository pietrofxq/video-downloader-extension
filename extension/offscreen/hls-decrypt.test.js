import { describe, it, expect } from 'vitest';
import { Parser } from 'm3u8-parser';
import { ivFromSequence, toUint8, importAesKey, decryptSegment } from './hls-decrypt.js';

describe('ivFromSequence', () => {
  it('produces a 16-byte zero-prefixed big-endian IV for sequence 0', () => {
    const iv = ivFromSequence(0);
    expect(iv.length).toBe(16);
    expect(Array.from(iv)).toEqual(new Array(16).fill(0));
  });

  it('encodes the sequence number in the low 8 bytes, big-endian', () => {
    // 1 → ...00 00 00 00 00 00 00 01
    expect(Array.from(ivFromSequence(1))).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    // 256 → ...00 00 00 00 00 00 01 00
    expect(Array.from(ivFromSequence(256))).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0,
    ]);
  });

  it('rejects invalid sequence numbers', () => {
    expect(() => ivFromSequence(-1)).toThrow();
    expect(() => ivFromSequence(NaN)).toThrow();
    expect(() => ivFromSequence(Infinity)).toThrow();
  });
});

describe('toUint8', () => {
  it('passes Uint8Array through', () => {
    const u8 = new Uint8Array([1, 2, 3]);
    expect(toUint8(u8)).toBe(u8);
  });

  it('serializes Uint32Array words big-endian (HLS IV byte order)', () => {
    // Bytes must come out big-endian regardless of host endianness:
    // 0x01020304 → [0x01, 0x02, 0x03, 0x04].
    const u32 = new Uint32Array([0x01020304]);
    const u8 = toUint8(u32);
    expect(Array.from(u8)).toEqual([0x01, 0x02, 0x03, 0x04]);
  });

  it('round-trips a full 16-byte IV from m3u8-parser big-endian', () => {
    // m3u8-parser stores parsed IV= attributes as a Uint32Array; the
    // wire-format must be big-endian per RFC 8216 §4.4.4.4.
    const parser = new Parser();
    parser.push(
      '#EXTM3U\n' +
        '#EXT-X-VERSION:3\n' +
        '#EXT-X-TARGETDURATION:6\n' +
        '#EXT-X-KEY:METHOD=AES-128,URI="k",IV=0x000102030405060708090A0B0C0D0E0F\n' +
        '#EXTINF:6,\n' +
        'seg.ts\n' +
        '#EXT-X-ENDLIST\n',
    );
    parser.end();
    const segIv = parser.manifest.segments[0].key.iv;
    expect(segIv).toBeInstanceOf(Uint32Array);
    const bytes = toUint8(segIv);
    expect(Array.from(bytes)).toEqual([
      0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e,
      0x0f,
    ]);
  });

  it('wraps a raw ArrayBuffer', () => {
    const ab = new ArrayBuffer(4);
    new Uint8Array(ab).set([1, 2, 3, 4]);
    expect(Array.from(toUint8(ab))).toEqual([1, 2, 3, 4]);
  });

  it('returns null for null / undefined', () => {
    expect(toUint8(null)).toBeNull();
    expect(toUint8(undefined)).toBeNull();
  });
});

describe('AES-128-CBC round-trip via Web Crypto', () => {
  it('decrypts a self-encrypted PKCS#7-padded block', async () => {
    // Skip if Web Crypto isn't available in this Node version
    if (typeof crypto === 'undefined' || !crypto.subtle) return;
    const keyBytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) keyBytes[i] = i;
    const iv = ivFromSequence(1);
    const plaintext = new TextEncoder().encode('hello world from hls');

    const rawKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, [
      'encrypt',
    ]);
    const encrypted = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, rawKey, plaintext),
    );

    const decryptKey = await importAesKey(keyBytes);
    const decrypted = await decryptSegment(encrypted, decryptKey, iv);
    expect(new TextDecoder().decode(decrypted)).toBe('hello world from hls');
  });

  it('importAesKey rejects keys that are not 16 bytes', async () => {
    if (typeof crypto === 'undefined' || !crypto.subtle) return;
    await expect(importAesKey(new Uint8Array(15))).rejects.toThrow();
    await expect(importAesKey(new Uint8Array(32))).rejects.toThrow();
  });
});
