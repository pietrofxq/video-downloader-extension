import { describe, it, expect } from 'vitest';
import { applyNTransform, compileTransform, extractNTransformSource } from './yt-sig.js';

// Synthetic base.js excerpt with the structural shape we extract:
//   - Get-callsite that names the transform function
//   - Function definition with the split → ops → join pattern
// This is intentionally minimal — the test pins the extractor's
// behavior against the structural pattern, NOT against a captured
// real-world base.js (those rotate). When YouTube ships a player
// build the production regex can't parse, the fix is "add a new
// pattern + add a new fixture-based test case here."
const FAKE_BASE_JS = `
(function() {
  // Some unrelated minified preamble.
  var Aaa = function(x) { return x + 1; };
  // The n-transform sits here. Real ones are 20–40 lines; we use a
  // simple reverse-then-uppercase so the test can assert behavior.
  var Bsa = function(a) {
    var b = a.split("");
    b.reverse();
    return b.join("").toUpperCase();
  };
  // The get("n") callsite invokes Bsa.
  function setupPlayer(c) {
    var b;
    (b = c.get("n")) && (b = Bsa(b)) && c.set("n", b);
  }
})();
`;

describe('extractNTransformSource', () => {
  it('locates the n-transform function definition via the get("n") callsite', () => {
    const source = extractNTransformSource(FAKE_BASE_JS);
    expect(source).not.toBeNull();
    expect(source).toContain('a.split("")');
    expect(source).toContain('return b.join("").toUpperCase()');
    // Should be the full function literal, not the surrounding var binding.
    expect(source!.startsWith('function')).toBe(true);
    expect(source!.endsWith('}')).toBe(true);
  });

  it('returns null when no get("n") callsite is found', () => {
    expect(extractNTransformSource('var foo = 1; console.log("hi");')).toBeNull();
  });

  it('returns null when callsite exists but function definition is missing', () => {
    const js = `
      (b = c.get("n")) && (b = MissingFn(b));
    `;
    expect(extractNTransformSource(js)).toBeNull();
  });
});

describe('compileTransform + behavior', () => {
  it('round-trips through compileTransform: input → transformed', () => {
    const source = extractNTransformSource(FAKE_BASE_JS);
    const fn = compileTransform(source!);
    // Our fake transform: reverse then uppercase.
    expect(fn('hello')).toBe('OLLEH');
    expect(fn('abcd')).toBe('DCBA');
  });

  it('throws when the extracted source is not a function literal', () => {
    expect(() => compileTransform('not a function')).toThrow();
  });
});

describe('applyNTransform', () => {
  const fakeSolver = {
    transformN: (n: string) => `${n}_rewritten`,
    source: '',
  };

  it('rewrites the n query parameter when present', () => {
    const url = 'https://x/videoplayback?itag=18&n=abc123&mime=video%2Fmp4';
    const out = applyNTransform(url, fakeSolver);
    const u = new URL(out);
    expect(u.searchParams.get('n')).toBe('abc123_rewritten');
    expect(u.searchParams.get('itag')).toBe('18');
  });

  it('passes through URLs with no n parameter', () => {
    const url = 'https://x/videoplayback?itag=18';
    expect(applyNTransform(url, fakeSolver)).toBe(url);
  });

  it('catches solver throws and returns the input URL', () => {
    const throwingSolver = {
      transformN: () => {
        throw new Error('bad');
      },
      source: '',
    };
    const url = 'https://x/videoplayback?n=abc';
    expect(applyNTransform(url, throwingSolver)).toBe(url);
  });

  it('treats empty-string transforms as no-op', () => {
    const emptySolver = {
      transformN: () => '',
      source: '',
    };
    const url = 'https://x/videoplayback?n=abc';
    expect(applyNTransform(url, emptySolver)).toBe(url);
  });
});
