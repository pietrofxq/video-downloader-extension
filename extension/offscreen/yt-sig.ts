// YouTube URL signing — the "n parameter" solver.
//
// Every `videoplayback?...` URL carries an `n=<obfuscated>` query
// parameter. YouTube's player runs a JS function from `base.js` that
// transforms `n` → `n'` before fetching; the CDN rejects (modern: 403,
// historic: heavy throttling) requests where `n` hasn't been resigned.
//
// This module:
//   1. Fetches base.js once per player URL via the content-script
//      proxy (so cookies + origin match what YouTube expects).
//   2. Extracts the n-transform function definition using regex
//      patterns. These ARE the brittle bit — YouTube rotates the
//      obfuscation periodically. The patterns here are intentionally
//      structural (looking for `.split("...")` + `.join("...")` and
//      the get("n") callsite) so small renames don't break us.
//   3. Compiles the extracted source via `Function()` and caches the
//      result keyed by the player URL. Subsequent transforms are O(1).
//
// Reference: @distube/ytdl-core's lib/sig.js (MIT) — same problem,
// same approach. When YouTube ships a player build this code can't
// parse, update the regex set below; check ytdl-core's recent commits
// for the working pattern.
//
// CSP / sandbox: the offscreen document is a regular HTML page in the
// extension origin. `new Function(...)` works there (CSP allows it).
// Compiling in the SW would NOT work — service worker CSP forbids
// eval / Function() — which is why the solver lives here.

import { fetchText, type ProxyFetch } from './downloader.js';
import { log, redactUrl } from '../lib/log.js';

export interface CompiledSolver {
  /** Apply the n-transform to a single n value. Throws if the
   * compiled function throws (e.g. unexpected input shape). */
  transformN: (n: string) => string;
  /** Extracted source, kept for diagnostics — never logged with the
   * caller's data. */
  source: string;
}

// Memoize the compile per player URL. YouTube rotates base.js URLs
// when it deploys a new player (the hash in the path changes), so a
// URL-keyed cache survives until the next rotation. Promise-valued
// so concurrent first-callers share one fetch + compile.
const solverCache = new Map<string, Promise<CompiledSolver>>();

/**
 * Idempotently fetch + compile the n-transform for a given base.js.
 * Subsequent calls with the same URL share the cached promise. If
 * the compile fails, the entry is dropped so the next call retries.
 */
export function getSolver(args: {
  playerJsUrl: string;
  proxyFetch: ProxyFetch;
  tabId: number;
  frameId: number;
  signal?: AbortSignal;
}): Promise<CompiledSolver> {
  const cached = solverCache.get(args.playerJsUrl);
  if (cached) return cached;
  const compiling = compileSolver(args).catch((err) => {
    solverCache.delete(args.playerJsUrl);
    throw err;
  });
  solverCache.set(args.playerJsUrl, compiling);
  return compiling;
}

async function compileSolver(args: {
  playerJsUrl: string;
  proxyFetch: ProxyFetch;
  tabId: number;
  frameId: number;
  signal?: AbortSignal;
}): Promise<CompiledSolver> {
  const baseJsText = await fetchText(args.proxyFetch, {
    tabId: args.tabId,
    frameId: args.frameId,
    url: args.playerJsUrl,
    signal: args.signal,
  });
  const source = extractNTransformSource(baseJsText);
  if (!source) {
    throw new Error(
      `yt-sig: could not locate n-transform function in ${redactUrl(args.playerJsUrl)}`,
    );
  }
  const transformN = compileTransform(source);
  log.info('yt-sig compiled', { url: redactUrl(args.playerJsUrl), len: source.length });
  return { transformN, source };
}

/**
 * Walk `base.js` looking for the n-transform function definition.
 * Strategy:
 *   1. Find the `.get("n")` callsite to identify the function NAME
 *      that's invoked on the result (the n-transform).
 *   2. Look up `var <NAME> = function(a){var b=a.split("...")...
 *      return b.join("...")};` and return the full definition.
 *
 * Exported for fixture-based unit tests. Brittle to YouTube changes —
 * if it returns null on a new build, add a new pattern to either step
 * and back-port via tests.
 */
export function extractNTransformSource(baseJs: string): string | null {
  const name = findNTransformName(baseJs);
  if (!name) return null;
  return findNTransformDefinition(baseJs, name);
}

// Pattern variants observed across YouTube player builds. The first
// capture group is always the function name. Patterns are tried in
// order until one matches. `\s*` everywhere so unminified / dev builds
// match the same as production minified output.
const ID = `[a-zA-Z0-9$_]+`;
const W = `\\s*`;
const NAME_NEAR_GET_N: ReadonlyArray<RegExp> = [
  // ...&&(b=a.get("n"))&&(b=NAME[idx](b))...    (array dispatch, common 2023+)
  new RegExp(
    `\\.get\\("n"\\)\\)${W}&&${W}\\(${W}${ID}${W}=${W}(${ID})${W}\\[${W}\\d+${W}\\]${W}\\(${W}${ID}${W}\\)${W}\\)`,
  ),
  // ...&&(b=a.get("n"))&&(b=NAME(b))...    (direct call, common form)
  new RegExp(
    `\\.get\\("n"\\)\\)${W}&&${W}\\(${W}${ID}${W}=${W}(${ID})${W}\\(${W}${ID}${W}\\)${W}\\)`,
  ),
  // (a=c.get("n"))&&(a=NAME(...))            (assign-and-call, weaker anchor)
  new RegExp(
    `\\(${W}${ID}${W}=${W}${ID}\\.get\\("n"\\)${W}\\)${W}&&${W}\\(${W}${ID}${W}=${W}(${ID})${W}\\(`,
  ),
];

function findNTransformName(text: string): string | null {
  for (const pat of NAME_NEAR_GET_N) {
    const m = text.match(pat);
    if (m && m[1]) return m[1];
  }
  return null;
}

/**
 * Given a function NAME, find its full `var NAME = function(arg){...};`
 * definition. Uses a balanced-brace walker (the body is large, and a
 * naive `[\s\S]+?\}` regex backtracks horribly on the megabyte-sized
 * base.js). Returns the full `function(arg){...}` source — what
 * `compileTransform` evaluates.
 */
function findNTransformDefinition(text: string, name: string): string | null {
  // Match `var NAME = function(arg) {` or `NAME = function(arg) {`.
  const escName = name.replace(/[$]/g, '\\$&');
  const headerRe = new RegExp(
    `(?:^|[^\\w$])${escName}\\s*=\\s*function\\s*\\([a-zA-Z0-9$_]+\\)\\s*\\{`,
    'm',
  );
  const m = headerRe.exec(text);
  if (!m) return null;
  const fnStart = m.index + m[0].length - 1; // points at the opening `{`
  const fnSource = walkBalancedBraces(text, fnStart);
  if (!fnSource) return null;
  const fnStartInText = text.indexOf('function', m.index);
  if (fnStartInText < 0) return null;
  return text.slice(fnStartInText, fnStart + fnSource.length);
}

function walkBalancedBraces(text: string, openBraceIdx: number): string | null {
  if (text[openBraceIdx] !== '{') return null;
  let depth = 0;
  let inString: '"' | "'" | '`' | null = null;
  let inRegex = false;
  let escape = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = openBraceIdx; i < text.length; i += 1) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && text[i + 1] === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      if (ch === '\\') escape = true;
      else if (ch === inString) inString = null;
      continue;
    }
    if (inRegex) {
      if (ch === '\\') escape = true;
      else if (ch === '/') inRegex = false;
      else if (ch === '\n') inRegex = false; // unterminated — bail
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }
    // Regex literal detection is genuinely hard in JS (depends on
    // preceding token). We don't try — minified base.js doesn't
    // typically expose unterminated-looking slashes in function
    // bodies. False matches here would manifest as undercount.
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(openBraceIdx, i + 1);
    }
  }
  return null;
}

/**
 * Compile the extracted `function(a){...}` source into a callable.
 * Wrap rather than `eval` so the function runs in its own scope and
 * we can pass arguments explicitly.
 *
 * Exported for tests so they can verify a known-good fixture
 * end-to-end without going through the cache.
 */
export function compileTransform(source: string): (n: string) => string {
  // Defensive: ensure we got something that starts with `function`.
  // A bad extractor result would otherwise be a syntax error inside
  // the Function() constructor, which throws.
  const trimmed = source.trim();
  if (!/^function\s*\(/.test(trimmed)) {
    throw new Error(`yt-sig: extracted source is not a function literal`);
  }
  // The function takes one argument and returns a string. The wrapper
  // body parenthesizes the literal so it parses as an expression.
  const fn = new Function('n', `return (${trimmed})(n);`) as (n: string) => string;
  return fn;
}

/**
 * Rewrite a videoplayback URL with the transformed `n`. Idempotent
 * on URLs with no `n` parameter (returns input unchanged). Catches
 * solver errors and returns the input — the download will then fail
 * with a 403 / throttle, which the dispatch path surfaces; we don't
 * want to silently make an obviously-broken URL invisible.
 */
export function applyNTransform(url: string, solver: CompiledSolver): string {
  try {
    const u = new URL(url);
    const n = u.searchParams.get('n');
    if (!n) return url;
    const transformed = solver.transformN(n);
    if (typeof transformed !== 'string' || transformed.length === 0) {
      return url;
    }
    u.searchParams.set('n', transformed);
    return u.href;
  } catch {
    return url;
  }
}

/** Test helper — wipe the solver cache between cases. */
export function _clearSolverCacheForTests(): void {
  solverCache.clear();
}
