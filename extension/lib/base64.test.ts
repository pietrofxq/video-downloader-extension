import { describe, it, expect } from 'vitest';
import { uint8ArrayToBase64, base64ToUint8Array } from './base64.js';

describe('base64 round-trip', () => {
  it('round-trips ASCII bytes', () => {
    const input = new TextEncoder().encode('hello world');
    const b64 = uint8ArrayToBase64(input);
    expect(b64).toBe('aGVsbG8gd29ybGQ=');
    const out = base64ToUint8Array(b64);
    expect(new TextDecoder().decode(out)).toBe('hello world');
  });

  it('round-trips arbitrary binary including 0x00 and 0xff', () => {
    const u8 = new Uint8Array([0, 1, 127, 128, 255, 0xab, 0xcd]);
    const round = base64ToUint8Array(uint8ArrayToBase64(u8));
    expect(Array.from(round)).toEqual(Array.from(u8));
  });

  it('handles a buffer larger than the CHUNK threshold (32 KB)', () => {
    const u8 = new Uint8Array(100_000);
    for (let i = 0; i < u8.length; i++) u8[i] = i & 0xff;
    const round = base64ToUint8Array(uint8ArrayToBase64(u8));
    expect(round.length).toBe(u8.length);
    for (let i = 0; i < u8.length; i++) {
      if (round[i] !== u8[i]) throw new Error(`byte ${i} mismatch`);
    }
  });

  it('handles an empty buffer', () => {
    const u8 = new Uint8Array(0);
    expect(uint8ArrayToBase64(u8)).toBe('');
    expect(base64ToUint8Array('').length).toBe(0);
  });

  it('rejects non-Uint8Array inputs', () => {
    // Casts intentional — the test asserts that runtime guards fire even
    // when callers reach for the function with the wrong type.
    expect(() => uint8ArrayToBase64('hello' as unknown as Uint8Array)).toThrow();
    expect(() => uint8ArrayToBase64(null as unknown as Uint8Array)).toThrow();
    expect(() => base64ToUint8Array(123 as unknown as string)).toThrow();
  });
});
