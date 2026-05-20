import { describe, it, expect } from 'vitest';
import { buildExtractedScript } from './yt-sig.js';

// Synthetic base.js excerpt that satisfies the alr-anchored matcher
// from extension/vendor/youtubei-js/matchers.ts AND the IIFE-only walk
// in JsAnalyzer:
//   - Top-level is an IIFE — `(function(_globalThis){...})({})`. The
//     analyzer ignores everything outside this IIFE (real YouTube
//     base.js has the same shape: `(function(){...})(this)`).
//   - Inside the IIFE: a VariableDeclarator with a FunctionExpression
//     init, 3+ params with two AssignmentPattern defaults, a body
//     containing `firstParam = new X.Y(firstParam)` (NewExpression
//     with MemberExpression callee), and a top-level
//     `.set("alr","yes")` ExpressionStatement.
const FAKE_BASE_JS = `
(function(_globalThis) {
  "use strict";
  var ctors = { URL: URL };
  var helperA = { x: 1 };
  var bag = new Map();
  var nFn = function(url, sp = "s", s = "n") {
    url = new ctors.URL(url);
    bag.set("alr", "yes");
    url.searchParams.set("helper", helperA.x);
    return url;
  };
  function unrelated() { return 1; }
})({});
`;

describe('buildExtractedScript', () => {
  it('emits a script that includes the matched URL-prep function', () => {
    const out = buildExtractedScript(FAKE_BASE_JS);
    // The IIFE-wrapped output should include the function body
    // (matched by the alr-yes anchor) and the helperA dependency it
    // references.
    expect(out).toContain('"alr"');
    expect(out).toContain('"yes"');
    expect(out).toContain('helperA');
  });

  it('throws when no matching function exists', () => {
    const noMatch = `
      var someFn = function(a) { return a + 1; };
      function other() {}
    `;
    expect(() => buildExtractedScript(noMatch)).toThrow();
  });

  it('emitted script evaluates without throwing', () => {
    const out = buildExtractedScript(FAKE_BASE_JS);
    // Wrap in a Function() to make sure the IIFE parses + runs in a
    // fresh scope. We don't assert on what it does — just that it
    // doesn't throw at evaluation time. The vendored extractor wraps
    // everything in its own IIFE so the script doesn't need a return
    // statement to be a syntactically valid Function body.
    expect(() => new Function(out)()).not.toThrow();
  });
});
