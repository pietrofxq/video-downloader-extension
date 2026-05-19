import { describe, it, expect } from 'vitest';
import { sanitizeFilename } from './sanitize-filename.js';

describe('sanitizeFilename', () => {
  it('strips illegal characters', () => {
    expect(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j')).toBe('abcdefghij');
  });

  it('collapses whitespace and trims', () => {
    expect(sanitizeFilename('  hello   world  ')).toBe('hello world');
  });

  it('strips control chars', () => {
    expect(sanitizeFilename('hi\x00there\x1f')).toBe('hithere');
  });

  it('trims trailing dots and spaces (Windows quirk)', () => {
    expect(sanitizeFilename('name....')).toBe('name');
    expect(sanitizeFilename('name   ')).toBe('name');
    expect(sanitizeFilename('  .name')).toBe('name');
  });

  it('keeps accented characters', () => {
    expect(sanitizeFilename('Lição 3')).toBe('Lição 3');
  });

  it('truncates to maxLength', () => {
    const long = 'a'.repeat(300);
    expect(sanitizeFilename(long)).toHaveLength(200);
  });

  it('falls back when input is empty / null / only-illegal', () => {
    expect(sanitizeFilename('')).toBe('video');
    expect(sanitizeFilename(null)).toBe('video');
    expect(sanitizeFilename('////')).toBe('video');
    expect(sanitizeFilename('xxx', { fallback: 'custom' })).toBe('xxx');
    expect(sanitizeFilename('', { fallback: 'custom' })).toBe('custom');
  });

  it('coerces non-strings via String()', () => {
    expect(sanitizeFilename(42)).toBe('42');
  });
});
