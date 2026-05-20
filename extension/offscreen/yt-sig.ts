// YouTube URL signing — n-param + signature decipher.
//
// Every `videoplayback?...` URL on modern YouTube carries an `n=...`
// query parameter that must be re-signed by an obfuscated JS function
// from `base.js`, or the CDN 403s the request. Higher-quality formats
// additionally come as `signatureCipher=url=...&s=...&sp=...` — the
// URL is encoded and the signature has to be deciphered through a
// separate function from the same base.js.
//
// We use the AST-based extractor vendored from LuanRT/YouTube.js
// (extension/vendor/youtubei-js/) to find the URL-preparation function
// that handles BOTH transforms. The matcher's anchor is the
// `.set("alr","yes")` call inside the function body — that's the
// YouTube player-contract literal that hasn't moved across multiple
// player rotations.
//
// Evaluation happens inside the offscreen document via `new Function()`
// (CSP for service workers forbids eval / Function; the offscreen page
// is regular DOM context where it works). The vendored extractor
// wraps everything in an IIFE with fake globals (window, document,
// self) and filters out side-effect initializers — see
// `extension/vendor/youtubei-js/JsExtractor.ts:329-513`.

import { JsAnalyzer, type ExtractionConfig } from '../vendor/youtubei-js/JsAnalyzer.js';
import { JsExtractor } from '../vendor/youtubei-js/JsExtractor.js';
import { nsigMatcher } from '../vendor/youtubei-js/matchers.js';
import { fetchText, type ProxyFetch } from './downloader.js';
import { log, redactUrl } from '../lib/log.js';

const NSIG_EXPORT_NAME = 'nsigFunction';

export interface SignatureCipherInput {
  /** Raw value of `signatureCipher` (or `cipher`) from a YouTube
   * format. URL-encoded `url=...&s=...&sp=...`. */
  signatureCipher: string;
}

export type DecipherInput = string | SignatureCipherInput;

export interface CompiledSolver {
  /**
   * Apply n-transform + signature-decipher to whatever URL form the
   * caller has. Returns a fetchable absolute URL.
   *
   * - Pass a plain URL string → only the `n` query param is
   *   transformed (signature pass is skipped).
   * - Pass `{ signatureCipher }` → the encoded triple is parsed,
   *   both transforms are applied, the deciphered signature is
   *   written under the parameter name from `sp`, and the result
   *   URL is returned.
   *
   * Errors are caught + logged; the input is returned unchanged so a
   * subsequent fetch produces a deterministic failure mode (403 from
   * the CDN) rather than vanishing silently.
   */
  decipher(input: DecipherInput): string;

  /** Per-input cache so repeat n values across chunk URLs only
   * transform once. Shared across all decipher() calls on this
   * solver. */
  readonly nCache: Map<string, string>;
}

// Memoize compile by base.js URL. YouTube rotates the URL on every
// player redeploy (the hash in the path changes), so this naturally
// invalidates when YouTube ships a new player.
const solverCache = new Map<string, Promise<CompiledSolver>>();

/**
 * Idempotently fetch + compile the signer for a given base.js URL.
 * Concurrent first-callers share one fetch + compile. On compile
 * failure the cache entry is dropped so the next call retries.
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

  // Parse base.js → AST → extract the URL-prep function + its
  // transitive dependencies via the vendored analyzer.
  const built = buildExtractedScript(baseJsText);
  log.info('yt-sig compiled', {
    url: redactUrl(args.playerJsUrl),
    bytes: built.length,
  });

  const nCache = new Map<string, string>();

  const decipher = (input: DecipherInput): string => {
    try {
      return runDecipher(built, input, nCache);
    } catch (err) {
      log.warn('yt-sig decipher failed; returning unchanged URL', {
        err: err instanceof Error ? err.message : String(err),
      });
      return typeof input === 'string' ? input : `signatureCipher=${input.signatureCipher}`;
    }
  };

  return { decipher, nCache };
}

/**
 * Run the vendored analyzer + extractor against base.js to produce
 * the IIFE source that exports `exportedVars.nsigFunction`.
 *
 * Exported for unit tests so they can compile a synthetic base.js
 * fixture without going through the proxyFetch path.
 */
export function buildExtractedScript(source: string): string {
  const extractions: ExtractionConfig[] = [{ friendlyName: NSIG_EXPORT_NAME, match: nsigMatcher }];
  const analyzer = new JsAnalyzer(source, { extractions });
  const extractor = new JsExtractor(analyzer);
  const result = extractor.buildScript({
    disallowSideEffectInitializers: true,
  });
  if (!result.exported.includes(NSIG_EXPORT_NAME)) {
    throw new Error('yt-sig: AST extraction failed to locate the n/sig decipher function');
  }
  return result.output;
}

/**
 * Compose the IIFE source + the process wrapper, evaluate via
 * `new Function()`, and return the deciphered URL. Mirrors the
 * pattern in YouTube.js `src/utils/Utils.ts:266` (getNsigProcessorFn)
 * and `src/core/Player.ts:129-225` (Player.decipher).
 *
 *  - For a plain URL string, only the n-transform applies.
 *  - For a signatureCipher input, the URL is reconstructed from the
 *    encoded `url=...&s=...&sp=...` triple.
 */
function runDecipher(
  extractedSource: string,
  input: DecipherInput,
  nCache: Map<string, string>,
): string {
  // Pull s/sp/url out of signatureCipher; build the working URL.
  let workingUrlStr: string;
  let s: string | null = null;
  let sp: string | null = null;
  if (typeof input === 'string') {
    workingUrlStr = input;
  } else {
    const params = new URLSearchParams(input.signatureCipher);
    workingUrlStr = params.get('url') || '';
    s = params.get('s');
    sp = params.get('sp');
    if (!workingUrlStr) {
      throw new Error('signatureCipher missing url= component');
    }
  }

  const url = new URL(workingUrlStr);
  const n = url.searchParams.get('n');

  const evalArgs: { n?: string | null; sp?: string | null; s?: string | null } = {};
  if (s) {
    evalArgs.s = s;
    evalArgs.sp = sp;
  }
  if (n) {
    // n-cache hit — skip the eval entirely, this is the hot path on
    // adaptive segment URLs that all share the same n.
    const hit = nCache.get(n);
    if (hit !== undefined) {
      url.searchParams.set('n', hit);
    } else {
      evalArgs.n = n;
    }
  }

  // Nothing to transform? Return the working URL unchanged.
  if (evalArgs.n === undefined && evalArgs.s === undefined) {
    return url.href;
  }

  const processorSrc = buildProcessorWrapper();
  const fullScript = `${extractedSource}\n${processorSrc}\nreturn __vdl_process(${JSON.stringify(evalArgs)});`;

  const fn = new Function(fullScript);
  const result = fn() as { n?: string; sig?: string };
  if (typeof result !== 'object' || result === null) {
    throw new Error('decipher script returned non-object');
  }

  if (typeof result.sig === 'string') {
    const targetParam = sp || 'signature';
    url.searchParams.set(targetParam, result.sig);
  }
  if (typeof result.n === 'string' && evalArgs.n) {
    if (result.n.startsWith('enhanced_except_')) {
      log.warn('yt-sig: n-transform returned an error sentinel', {
        n: evalArgs.n,
        result: result.n,
      });
    } else {
      nCache.set(evalArgs.n, result.n);
    }
    url.searchParams.set('n', result.n);
  }

  return url.href;
}

/**
 * Build the process wrapper called inside the eval. Pulled from
 * YouTube.js `src/utils/Utils.ts:266`. The URL-prep function returns
 * a URL-like object whose prototype methods are the actual decipher
 * operations — we have to call each non-blacklisted method to apply
 * them, then read back the transformed values via `.get(...)`.
 */
function buildProcessorWrapper(): string {
  return `
function __vdl_process(args) {
  var n = args.n || "";
  var sp = args.sp || "";
  var s = args.s || "";
  var mockUrl = "https://vdl.googlevideo.com/videoplayback?expire=1234567890&n=" + encodeURIComponent(n);
  var urlCtorFn = exportedVars && exportedVars.${NSIG_EXPORT_NAME};
  if (!urlCtorFn) throw new Error("nsigFunction missing");
  var urlCtor = urlCtorFn(mockUrl, sp, s);
  var proto = Object.getPrototypeOf(urlCtor);
  var props = Object.getOwnPropertyNames(proto);
  var blacklist = { constructor: 1, clone: 1, set: 1, get: 1 };
  for (var i = 0; i < props.length; i++) {
    var p = props[i];
    if (blacklist[p]) continue;
    if (typeof urlCtor[p] === "function") {
      try { urlCtor[p](); } catch (e) {}
    }
  }
  var sigResult = sp ? urlCtor.get(sp) : null;
  var nResult = urlCtor.get("n");
  return {
    sig: sigResult ? decodeURIComponent(sigResult) : undefined,
    n: nResult ? decodeURIComponent(nResult) : undefined
  };
}
`;
}

// ---------- YouTube auto-discovery via iframe_api ----------
//
// Scraping <script src> from the watch page DOM proved unreliable
// (player JS isn't always in the static DOM by document_idle time;
// SPA-navigated states often miss it). YouTube.js sidesteps this by
// fetching `/iframe_api` — a stable, tiny JS bundle that embeds the
// current `player_id` — and deriving the canonical player URL from
// there. We do the same. The fetch goes through the existing
// proxyFetch so it originates from the YouTube tab (cookies + origin
// match what YouTube's CDN expects).

const YT_HOME = 'https://www.youtube.com';
const IFRAME_API_URL = `${YT_HOME}/iframe_api`;
// Matches `player\/<id>\/` in the iframe_api JS source. The slashes
// are escaped (JS string literal in the response body), so the regex
// looks for the literal backslash + slash on either side of the id.
const PLAYER_ID_RE = /player\\\/([^\\\/]+)\\\//;

// Player.js URL keyed by player_id. The id rotates only when YouTube
// deploys a new player, so this cache survives the rest of the
// session naturally.
const youtubeSolverByPlayerId = new Map<string, Promise<CompiledSolver>>();

export interface YouTubeSolverContext {
  proxyFetch: ProxyFetch;
  tabId: number;
  frameId: number;
  signal?: AbortSignal;
}

/**
 * Discover + compile the YouTube signer for the current player.
 * Two-step:
 *   1. Fetch `/iframe_api`, regex-extract the player_id.
 *   2. Build `https://www.youtube.com/s/player/<id>/player_es6.vflset/en_US/base.js`,
 *      fetch + extract + compile via `getSolver`.
 *
 * The result is cached by player_id so callers from different
 * downloads in the same session share one compilation.
 */
export async function getYouTubeSolver(ctx: YouTubeSolverContext): Promise<CompiledSolver> {
  const playerId = await fetchPlayerId(ctx);
  const cached = youtubeSolverByPlayerId.get(playerId);
  if (cached) return cached;

  const playerUrl = `${YT_HOME}/s/player/${playerId}/player_es6.vflset/en_US/base.js`;
  log.info('yt-sig: resolved player', { playerId, playerUrl: redactUrl(playerUrl) });
  const compiling = getSolver({
    playerJsUrl: playerUrl,
    proxyFetch: ctx.proxyFetch,
    tabId: ctx.tabId,
    frameId: ctx.frameId,
    signal: ctx.signal,
  }).catch((err) => {
    youtubeSolverByPlayerId.delete(playerId);
    throw err;
  });
  youtubeSolverByPlayerId.set(playerId, compiling);
  return compiling;
}

async function fetchPlayerId(ctx: YouTubeSolverContext): Promise<string> {
  const text = await fetchText(ctx.proxyFetch, {
    tabId: ctx.tabId,
    frameId: ctx.frameId,
    url: IFRAME_API_URL,
    signal: ctx.signal,
  });
  const m = text.match(PLAYER_ID_RE);
  if (!m || !m[1]) {
    throw new Error('yt-sig: could not extract player id from iframe_api response');
  }
  return m[1];
}

/** Test helper — wipe the solver cache between cases. */
export function _clearSolverCacheForTests(): void {
  solverCache.clear();
  youtubeSolverByPlayerId.clear();
}
