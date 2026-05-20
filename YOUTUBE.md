# YOUTUBE.md — findings from LuanRT/YouTube.js relevant to v0.11+

Source studied: <https://github.com/LuanRT/YouTube.js> (cloned shallow into `/tmp/youtube.js` during analysis). YouTube.js is the canonical maintained JS extractor — Deno, Node, web, React Native, Cloudflare Workers. What we copy / adapt from it will determine how long v0.11 stays working before YouTube ships a player update that breaks us.

This document is descriptive, not prescriptive. The "what we'd need to adapt" notes are observations about the gap between their approach and ours; whether to close that gap is a separate decision.

---

## 1. The architectural insight we were missing

Our current solver tries to extract **only the n-transform leaf function** by name (via `.get("n")` callsite regex). YouTube.js does something **structurally different and more stable**:

It extracts a **higher-level URL-preparation function** that internally calls both the n-transform AND the signature decipher. The matcher (`src/utils/javascript/matchers.ts:4`) identifies this function by these AST features:

- A `VariableDeclarator` with a `FunctionExpression` init
- **3+ parameters**: `(url, sig="s", sp="n")` — the second + third have `AssignmentPattern` (default values)
- Body contains:
  - An assignment `url = new <something>.URL(...)` — i.e. a `NewExpression` reassigning the url parameter
  - A `.set("alr", "yes")` call

That second feature — `.set("alr", "yes")` — is the load-bearing anchor. `alr` is the YouTube "auto live retry" flag the player sets when preparing a download URL. YouTube has not renamed or removed it across multiple player rotations.

**Why this is more stable than what we're doing:** function names rotate every player redeploy, but the structural shape of the URL-preparation function doesn't. The `.set("alr","yes")` literal is a documented player contract.

**Source:** `/tmp/youtube.js/src/utils/javascript/matchers.ts:4-52` (the matcher), `/tmp/youtube.js/src/core/Player.ts:91-122` (how it's wired).

**Gap with our code:** ours uses a `.get("n")` regex that targets the leaf transform. YouTube.js's approach targets the orchestration function and lets the dependency walker pull in everything it needs (including the n-transform AND the sig decipher). We could adopt this anchor without adopting the full AST machinery — just rewrite the regex to look for `.set("alr","yes")` and balance-walk the enclosing function.

---

## 2. They use a real JS parser (meriyah), not regex

`src/utils/javascript/JsAnalyzer.ts` and `JsExtractor.ts` use **meriyah** (a small ES2022 parser, ~20KB minified) to build an AST of `base.js`, then walk it for both the matcher (above) and dependency collection.

**Why an AST instead of regex:**

1. **Dependency extraction.** The n-transform function references a giant object literal (`var Bsa = { fn1: ..., fn2: ..., fn3: ... }`) and several helper functions. The leaf n-transform alone doesn't run; you also need those dependencies in scope. AST gives reliable scope analysis; regex doesn't.

2. **Side-effect filtering.** `JsExtractor.ts:85-220` walks every variable initializer and replaces unsafe operations (function calls, `new`, etc.) with `undefined` when `disallowSideEffectInitializers: true` is set. This prevents the extracted code from inadvertently calling `fetch()`, mutating `document`, etc. when evaluated. Regex can't do this safely.

3. **Multiple extractions in one pass.** They extract `nsigFunction` AND `signatureTimestamp` in the same AST walk (`Player.ts:94-97`):
   ```ts
   const extractions: ExtractionConfig[] = [
     { friendlyName: nsigFunctionName, match: nsigMatcher },
     { friendlyName: timestampVarName, match: timestampMatcher, collectDependencies: false }
   ];
   ```
   `signatureTimestamp` is a constant YouTube uses to validate the player version; we'll need it eventually if we add the embed-watch path.

**Source:** `/tmp/youtube.js/src/utils/javascript/JsAnalyzer.ts` (parser + walker), `/tmp/youtube.js/src/utils/javascript/JsExtractor.ts` (dependency collection + side-effect filtering).

**Gap with our code:** we hand-roll a balanced-brace walker. That works for "give me one function body". It does NOT work for "give me one function + every variable it depends on + every helper those depend on, transitively". If we want a solver that survives more than one player rotation, we'd need either an AST parser or a much smarter regex bag than what we ship today.

**Sizing:** meriyah is ~20KB minified. The extension's offscreen bundle today is ~1.4MB (mostly mux.js). Adding meriyah is a small relative cost.

---

## 3. Side-effect filtering when evaluating

`JsExtractor.ts:85-220` is the part that makes evaluation safe. After collecting the function + its dependencies, it wraps everything in an IIFE that provides **fake globals**:

```js
const exportedVars = (function(globalThis) {
  const window = typeof __jsExtractorGlobal.window !== 'undefined' ? __jsExtractorGlobal.window : Object.create(null);
  const document = typeof __jsExtractorGlobal.document !== 'undefined' ? __jsExtractorGlobal.document : {};
  const self = typeof __jsExtractorGlobal.self !== 'undefined' ? __jsExtractorGlobal.self : window;
  // ...extracted source...
  return { nsigFunction, rawValues };
})({});
```

Plus the side-effect filter: if a top-level variable's initializer is something like `var x = someFn()`, the initializer is replaced with `undefined` (so the dependency is still in scope but doesn't execute the call). `Math`, `String`, `Array`, etc. are whitelisted via `jsBuiltIns` (`src/utils/javascript/helpers.ts:6-21`).

**Source:** `/tmp/youtube.js/src/utils/javascript/JsExtractor.ts:329-513` (wrap), `:85-220` (filter), `helpers.ts:6-21` (whitelist).

**Gap with our code:** we use bare `new Function('n', '...')`. That works because today our extracted function is the leaf (no globals to reference). If we move to extracting the higher-level URL-preparation function (which references YouTube's own helpers), we'd need this fake-globals + side-effect-filter wrapping or the eval will crash on missing references.

---

## 4. The decipher orchestration

`src/core/Player.ts:129-225` (`Player.decipher`) is the entry point that other code calls. The flow:

```ts
async decipher(url?, signature_cipher?, cipher?, nsigCache?) {
  // 1. Pull s/sp from signatureCipher (it's encoded as: url=...&s=...&sp=...)
  const args = new URLSearchParams(url || signature_cipher || cipher);
  const url_components = new URL(args.get('url') || url);
  const n = url_components.searchParams.get('n');
  const s = args.get('s');
  const sp = args.get('sp');

  // 2. Build eval args. Both sig + n go to ONE evaluation pass.
  const eval_args = {};
  if (signature_cipher || cipher) {
    eval_args.sig = s;
    eval_args.sp = sp;
  }
  if (n) {
    if (nsigCache?.has(n)) {
      url_components.searchParams.set('n', nsigCache.get(n));
    } else {
      eval_args.n = n;
    }
  }

  // 3. Eval the compiled script. Result is { sig, n }.
  const result = await Platform.shim.eval(data, eval_args);

  // 4. Patch URL with both results.
  if (eval_args.sig) url_components.searchParams.set(sp ?? 'signature', result.sig);
  if (eval_args.n) {
    if (result.n.startsWith('enhanced_except_')) {
      Log.warn(`Decipher returned error: ${result.n}`);
    } else {
      nsigCache?.set(n, result.n);
    }
    url_components.searchParams.set('n', result.n);
  }

  // 5. Append PoToken when present (and not SABR).
  if (url_components.searchParams.get('sabr') !== '1' && this.po_token) {
    url_components.searchParams.set('pot', this.po_token);
  }
}
```

Three things to note:

- **`signatureCipher` strings are URL-form-encoded triples** `url=...&s=...&sp=...`. The `sp` parameter is the name of the query param to set on the final URL (could be `signature`, `sig`, or others — varies by client).
- **`enhanced_except_<thing>` return value** is YouTube's way of saying "I refused to transform this n". If we get that back, it's not a successful decipher — log and continue, but expect the CDN to 403.
- **`nsigCache` is per-response, not global.** YouTube uses different `n` values for different chunk requests; caching transforms by input value avoids re-eval per chunk.

**Source:** `/tmp/youtube.js/src/core/Player.ts:129-225`.

**Gap with our code:** we only handle the n-param, never the signature. For most modern videos, `streamingData.adaptiveFormats` URLs are exclusively `signatureCipher`-protected (no direct `url` field). Our current "skip formats without a direct url" filter is why our picker only ever shows `itag=18` — we're filtering out everything that needs signature decipher. **If we add the signature decipher, we unlock every quality, not just 360p.**

---

## 5. PoToken (proof-of-origin)

`Player.ts:204-206`:

```ts
if (url_components.searchParams.get('sabr') !== '1' && this.po_token) {
  url_components.searchParams.set('pot', this.po_token);
}
```

So PoToken support is:
- Optional — `this.po_token` may be undefined; downloads still work for many videos
- Excluded from SABR (Server-side AdaptiveBitrate) URLs
- Appended as `pot=...` query param
- Stored as **raw bytes**, not base64

YouTube.js does **not** generate the PoToken — it accepts one from the caller (the Innertube constructor takes a `po_token` option). The token has to be obtained externally (BotGuard / Trusted Types attestation — there are companion projects like `bgutils-js` that handle it).

**Source:** `/tmp/youtube.js/src/core/Player.ts:204-206`, `src/Innertube.ts` for the constructor.

**Gap with our code:** we don't handle PoToken at all. Whether we need to depends on what YouTube enforces. From your smoke test, the URL was rejected before we even had a chance to set `pot`, so it might be either:
- The fundamental issue is the missing n-transform (which we're working on)
- OR additionally there's PoToken enforcement on top

Worth keeping in mind as a follow-up if we get the n-transform working but downloads still 403.

---

## 6. Player URL discovery

YouTube.js does NOT scrape `base.js` from the watch page DOM. Instead (`src/core/Player.ts:46-89`):

1. Fetch `https://www.youtube.com/iframe_api`
2. Extract `player_id` via regex from that response (a small JS bootstrap that names the current player)
3. Build the player URL: `https://www.youtube.com/s/player/${player_id}/player_es6.vflset/en_US/base.js`

Why: `iframe_api` is stable across watch / embed / shorts / mobile pages. Scraping the watch page's HTML works most of the time but fails on cached / SPA-navigated states where the script tag isn't present yet.

**Source:** `/tmp/youtube.js/src/core/Player.ts:43-127`.

**Gap with our code:** we scrape `<script src=".../base.js">` from the watch page DOM. The user's recent smoke test showed `playerJsUrl: null` from our extractor, which is consistent with the "the script tag isn't always present" gotcha. Switching to the `iframe_api` route would be more reliable, at the cost of one extra HTTP fetch per session (cacheable).

Note the path: they use `player_es6.vflset` not `player_ias.vflset`. Both exist on YouTube; the choice may matter. Worth following YouTube.js's lead.

---

## 7. Streaming data shape — what we should learn

`src/utils/StreamingInfo.ts` and `src/utils/FormatUtils.ts` show how YouTube.js processes `streamingData`. Notable shapes:

- **`signatureCipher` URL-encoded triple.** Format strings come either with `url=...` (direct) OR with `signatureCipher=url=...&s=...&sp=...` (encoded). Our current code skips the latter; YouTube.js parses + deciphers. Adding signature support is what unlocks 1080p / 1440p / 4K.
- **Adaptive video and adaptive audio are listed in one array** (`adaptiveFormats`). Our split into "video variants vs audio for pairing" matches what they do internally.
- **Per-format `has_audio` / `has_video` flags** (mimeType startsWith video/ vs audio/) — we already compute this; consistent with their approach.
- **Audio + video grouping for download.** They pick `video_groups[0][0]` (best video) + `audio_groups[0][0]` (best audio) for the adaptive-HD path. Same heuristic we plan to use.

**Source:** `/tmp/youtube.js/src/utils/StreamingInfo.ts:325-406` (cipher parsing), `:864-891` (grouping).

**Gap with our code:** structurally aligned. The thing we miss is `signatureCipher` parsing + applying the decipher to the decoded URL. That's a small addition once the solver itself handles signature transforms.

---

## 8. Constants we should mirror

`src/utils/Constants.ts:25-104`:

- **WEB client version** (currently `2.20260206.01.00`) — used as the `cver` query param on download URLs after decipher. Sent via `Player.decipher` line ~212.
- **`InnerTube` API keys** — used for backend API calls. Not relevant unless we move to the Innertube API path.

What's NOT in their `Constants.ts`:
- A canonical list of progressive itags. They appear to treat the distinction at runtime (`format.has_audio && format.has_video`). Our hardcoded `[18, 22, 36]` is reasonable for the moment but we could derive it from `streamingData.formats[]` directly (those are by definition the muxed ones).
- A codec-family lookup. They parse mimeType inline.

**Source:** `/tmp/youtube.js/src/utils/Constants.ts:25-104`.

---

## 9. Things we can copy verbatim today

Small wins we can take immediately without buying into the AST approach:

1. **Match `.set("alr", "yes")` as the structural anchor for the URL-prep function** instead of (or alongside) our `.get("n")` callsite regex. Stable across player rotations.
2. **Cache transforms by input value** in a per-response `Map<string, string>`. The same `n` value appears in many chunk URLs; transforming once per unique input is the right cost model.
3. **Recognize `enhanced_except_*` return values** as transform failures and log instead of using the result.
4. **Switch playerJsUrl discovery to fetching `/iframe_api`** and extracting `player_id` from there. More reliable than DOM scraping.
5. **Set `cver` on the final URL after decipher** (matches what the real player sends; some CDN paths may require it).
6. **Use `player_es6.vflset` path** in our URL construction rather than `player_ias.vflset`. YouTube.js targets the ES6 build.

None of these requires bundling an AST parser. They're all small adaptations to what we already have.

---

## 10. Things that need a real decision

These are bigger, and worth thinking about before committing:

1. **Adopt meriyah for AST-based extraction.** ~20KB cost, much more durable solver. Almost certainly the right move for "ship YouTube and have it keep working." Without it we're signing up for regular regex updates as YouTube rotates. Recommended.
2. **Extract the URL-prep function + dependencies, not just the n-transform.** Requires #1. Lets us handle `signatureCipher`-protected formats — which is most of `adaptiveFormats` — i.e. unlocks every quality above 360p without a separate `signatureCipher` decoder.
3. **PoToken pipeline.** Not built. Need to assess whether current YouTube enforces it; if so, we'd need a `bgutils-js`-equivalent. Defer until we have evidence we need it.
4. **Switch detection from "scrape page" to "Innertube API + iframe_api"?** Their primary mode is API-based. Ours is page-scrape. API mode is more reliable but pulls us further from the "passive observation" model the rest of the extension uses. Probably not — keep page-scrape unless it keeps breaking.

---

## License

YouTube.js is **MIT**. We can copy code and patterns directly with attribution. `src/utils/javascript/*` is the directory most worth copying from; everything we'd lift is in there.
