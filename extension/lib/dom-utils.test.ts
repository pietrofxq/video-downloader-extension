import { describe, it, expect } from 'vitest';
import { escapeHtml } from './dom-utils.js';

describe('escapeHtml', () => {
  it('escapes all five XSS-relevant characters', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
    );
  });

  it('escapes ampersand and single quote', () => {
    expect(escapeHtml("a & b ' c")).toBe('a &amp; b &#39; c');
  });

  it('coerces non-strings via String()', () => {
    expect(escapeHtml(42)).toBe('42');
    expect(escapeHtml(null)).toBe('null');
    expect(escapeHtml(undefined)).toBe('undefined');
  });

  it('returns empty string for empty input', () => {
    expect(escapeHtml('')).toBe('');
  });

  it('preserves characters that do not need escaping', () => {
    expect(escapeHtml('Lição 3 / Capítulo 4')).toBe('Lição 3 / Capítulo 4');
  });
});
