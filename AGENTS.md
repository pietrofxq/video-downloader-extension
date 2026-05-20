# AGENTS.md — Notes for coding agents working on this repo

This file briefs an LLM coding agent on the architecture, conventions, and gotchas of the Video Downloader extension. Read it before making changes.

---

## 1. What this project is

A **Manifest V3 Chrome extension** that detects, downloads, decrypts, and remuxes streaming video from arbitrary websites into plain MP4 files. Supports HLS (`.m3u8`), DASH (`.mpd`), and progressive (`.mp4` / `.webm`). A **site-adapter** system layers per-origin enhancements (metadata scraping, custom naming, auth quirks) on top of generic detection — **Hotmart Club** is the first and most-tested adapter, but the engine is site-agnostic and other adapters can be added without touching core code.

The original product spec (Hotmart-specific) lives in `plan.txt`; this document covers the broader engineering picture.

---

## 2. Tech stack & languages

| Layer | Choice | Notes |
|---|---|---|
| Extension platform | **Chrome Manifest V3** | Service worker (not persistent background page). |
| Language | **JavaScript (ES2022)** | No TypeScript initially — keep deps and build simple. Migrate to TS post-v1.3 once the adapter API surface stabilizes. |
| Bundler | **esbuild** | Fast, zero-config, IIFE bundles per content script entry. |
| Package manager | **npm** | Lockfile committed. |
| Media remux | **`mux.js`** (`mux.js` npm package) | MPEG-TS → fragmented MP4 stream-copy. **Never re-encode.** mux.js targets MSE, not on-disk files, so its output requires moov / moof post-patching before VLC and QuickTime will play it (see §8). |
| HLS parsing | **m3u8-parser** (npm) | Bundled, runs in offscreen document. |
| DASH parsing | **mpd-parser** (npm) | Same context as m3u8-parser. |
| Crypto | **Web Crypto API** (`crypto.subtle`) | AES-128-CBC for HLS, AES-CTR for DASH ClearKey. No external crypto libraries. **No DRM (Widevine/PlayReady/FairPlay).** |
| Tests | **Vitest** + **@vitest/web-worker** | Unit tests for parsers, filename sanitizer, IV derivation, message-bus shape, adapter matching. E2E later via Playwright with `chrome.launch` against fixture pages. |
| Lint/format | **ESLint** (flat config) + **Prettier** | Run on pre-commit via a simple npm script. |

---

## 3. Architecture (5 contexts, one job each)

Manifest V3 forces work to be split across isolated contexts. Keep the responsibilities sharp:

```
┌──────────────────────────────────────────────────────────────────────┐
│ Service Worker (background/service-worker.js)                        │
│  • webRequest listeners → capture .m3u8 / .mpd / progressive URLs    │
│  • pickAdapter(url, pageUrl) to tag each detection with adapterId    │
│  • Owns the canonical "detected media per tab" state (Map)           │
│  • Routes messages between contexts                                  │
│  • Spawns the offscreen document on demand and tears it down         │
│  • Calls chrome.downloads.download with the final blob URL           │
└──────────────────────────────────────────────────────────────────────┘
        ▲ chrome.runtime.sendMessage         ▼ chrome.offscreen.createDocument
┌─────────────────────────────┐     ┌──────────────────────────────────┐
│ Frame content script        │     │ Offscreen document               │
│ (all http(s) frames)        │     │ (offscreen/offscreen.html|.js)   │
│  • run_at: document_start   │     │  • m3u8 / mpd parse              │
│  • Hooks fetch + XHR        │     │  • Web Crypto AES-128 / AES-CTR  │
│  • Forwards URLs + headers  │     │  • mux.js remux + moov/moof patch│
└─────────────────────────────┘     │  • Reports progress via runtime  │
                                    └──────────────────────────────────┘
┌─────────────────────────────┐     ┌──────────────────────────────────┐
│ Page content script         │     │ Popup (popup/popup.html|.js)     │
│ (all http(s) top frames)    │     │  • Lists detected media          │
│  • Scrapes <title>, OG meta │     │  • Quality picker, subtitles     │
│  • Loaded adapter (if any)  │     │  • Per-row adapter badge         │
│    scrapes richer metadata  │     │  • Triggers download + progress  │
└─────────────────────────────┘     └──────────────────────────────────┘
```

**The service worker is the single source of truth for "what media exists on each tab."** Every other context queries or mutates that state through messages. Don't let the popup or content scripts hold their own copies.

---

## 4. Site adapters

Adapters live in `extension/adapters/` and let the extension behave well on specific sites without polluting core code. They are the *only* place site-specific logic should live.

### The contract

Each adapter exports a single object:

```js
// extension/adapters/example.js
export default {
  id: 'example',                            // stable kebab-case id used in messages and the UI badge
  matches(pageUrl, mediaUrl) { ... },       // boolean — does this adapter handle this detection?
  scrapePageMeta(document) { ... },         // optional — returns { title, hints, ... } from the top frame
  observe(document, onUpdate) { ... },      // optional — MutationObserver for SPAs; calls onUpdate(meta)
  deriveFilename({ pageMeta, url, mediaEntry }) { ... }, // returns sanitized filename (no extension)
  transformHeaders(headers) { ... },        // optional — patch outbound headers for segment fetches
};
```

Registered in `adapters/index.js`:

```js
import defaultAdapter from './default.js';
import hotmart from './hotmart.js';

const ORDERED = [hotmart, /* vimeo, bunny, ... */ defaultAdapter];

export function pickAdapter(pageUrl, mediaUrl) {
  return ORDERED.find(a => a.matches(pageUrl, mediaUrl));
}
```

**Ordering matters**: specific adapters first, `defaultAdapter` last (its `matches` is always `true`).

### Rules adapters must follow

- **No side effects on import.** All work happens in the exported methods.
- **No network calls** from `scrapePageMeta` — it runs in the page context and must be synchronous-ish.
- **No DRM logic.** If a site uses Widevine/PlayReady/FairPlay, the adapter should set `mediaEntry.drm = true` so the offscreen pipeline can surface `DRMProtectedError`.
- **No persistent storage.** Adapters are pure transformations; persistent state belongs to the service worker.
- **Default adapter is a hard fallback.** Never throw from `default.js` — it must always produce a working filename and meta object.

---

## 5. Key architectural decisions

### Why a content script in every frame (in addition to webRequest)
`webRequest.onBeforeRequest` sees the URL but cannot see request *bodies* or *headers added by JS*. The frame hook lets us capture URLs that only appear after JS-driven playback, and also capture custom `Authorization` headers via patched `XHR.setRequestHeader` / `fetch(init.headers)`. Both mechanisms are needed; the SW deduplicates by URL.

### Why an offscreen document, not the service worker
Service workers in MV3 are killed after ~30s idle and cannot hold large blobs or run typed-array-heavy code reliably. The remux pipeline (mux.js Transmuxer, manual moov patching, Web Crypto, Blob creation) all need a real Document context with stable memory. The **offscreen document** (`chrome.offscreen.createDocument`) is the MV3-sanctioned escape hatch for exactly this kind of work; we keep it alive across downloads and revoke each `blob:` URL via a `REVOKE_BLOB` message once `chrome.downloads.onChanged` reports complete or interrupted.

### Why the adapter pattern
Hotmart needs a cross-origin iframe scraper, signed-token handling, and a specific filename template. A second site (Vimeo, Bunny CDN, generic Video.js) will need a *different* set of three things. The adapter pattern keeps core code generic and pushes site oddities into ~50-line files that can be added or removed without touching the engine. The matching contract is also what makes the popup's per-row "adapter badge" possible.

### Why stream-copy remux (no re-encoding)
The source is almost always already H.264 + AAC. mux.js demuxes the MPEG-TS and re-wraps the elementary streams in a fragmented MP4 (`moof` + `mdat`) without touching the encoded samples — lossless and ~50× faster than re-encoding. **Never** introduce a re-encode path (libx264, AAC encode) into the offscreen document; if a future codec needs it, fail loudly with `UnsupportedFormatError` instead.

### Why mux.js (and not ffmpeg.wasm)
mux.js is ~150 KB of plain JS, ships as a normal npm dep, runs fine inside the offscreen document with no WASM or worker setup, and is the same library video.js uses for HLS playback in MSE. ffmpeg.wasm works but adds ~30 MB of WASM + a `vendor/` directory + cross-origin-isolation requirements (COOP/COEP headers in `web_accessible_resources`) that bloat the install. The trade-off is that mux.js targets MSE — its output assumes a player layers the timeline externally — so we patch the moov / moof boxes after remux (see §8). For long videos we drive mux.js segment-by-segment (push + flush) rather than concatenating the TS, which lets the post-patcher rewrite each `moof.tfdt` independently without re-parsing the whole TS stream.

### Why `<all_urls>` host permissions
The engine has to fetch segments from any origin (the offscreen document doesn't inherit the page's CORS context) and observe `webRequest` everywhere. `<all_urls>` is the simplest way; the trade-off is a scarier install prompt. The options page should explain this in plain language and let users disable detection per-origin if they want.

### Why no third-party servers
The extension MUST NOT contact anything other than the origin currently being downloaded from. No analytics, no remote config, no error reporting. This protects user privacy and keeps the install permissions defensible.

---

## 6. Message protocol

All cross-context messages go through `chrome.runtime.sendMessage` / `chrome.tabs.sendMessage` with a shared envelope:

```js
{ type: '<VERB>', payload: { ... }, requestId?: string }
```

Defined message types (keep this list authoritative — update it when adding new ones):

| Type | Direction | Purpose |
|---|---|---|
| `MEDIA_URL_DETECTED` | frame CS → SW | Reports a captured media URL with `{ url, pageUrl, kind, headers? }`. |
| `PAGE_META` | page CS → SW | Reports `{ tabId, adapterId, meta }` (page `<title>` + adapter-specific data). |
| `GET_TAB_STATE` | popup → SW | Asks for the current tab's detected-media list. |
| `TAB_STATE_UPDATED` | SW → popup | Push notification that the active tab's list changed. |
| `START_DOWNLOAD` | popup → SW | `{ tabId, mediaId, variant, includeSubtitles }`. |
| `DOWNLOAD_PROGRESS` | offscreen → SW → popup | `{ requestId, stage, current, total }`. |
| `DOWNLOAD_DONE` | offscreen → SW | `{ requestId, blobUrl, filename }`. |
| `DOWNLOAD_ERROR` | offscreen → SW → popup | `{ requestId, code, message }`. |

Every `MediaEntry` carries an `adapterId` from the moment it's detected; downstream consumers (popup, offscreen, options page) can rely on it being present. The SW is the hub — content scripts and popup never message each other directly.

---

## 7. Style guide

- **Module style**: ES modules everywhere except content scripts (which esbuild bundles to IIFE).
- **Naming**: `camelCase` for variables/functions, `PascalCase` for classes, `SCREAMING_SNAKE_CASE` for message-type constants. Adapter files are kebab-case (`hotmart.js`, `vimeo.js`); their `id` field matches the filename minus `.js`.
- **No default exports**, except adapters (which export a single default object — convention is explicit there).
- **Async**: `async`/`await`, not raw `.then` chains. Top-level `await` is fine in offscreen + popup modules.
- **No `console.log` in committed code.** Use a tiny `lib/log.js` with `debug` / `info` / `warn` / `error` levels gated on a `chrome.storage.local` flag. **Always redact sensitive query params** before logging URLs — `lib/log.js` exposes `redactUrl(url)` which strips a configurable set (`hdntl`, `token`, `signature`, `Policy`, `Signature`, `Key-Pair-Id`, etc.).
- **No comments that restate the code.** Only comment the *why* — token expiry, AES IV fallback, HLS spec quirks, adapter rationale.
- **Filenames**: kebab-case (`service-worker.js`, `frame-content.js`).
- **Imports**: third-party first, then `lib/`, then `adapters/`, then relative. One blank line between groups.
- **Errors**: throw typed errors from `lib/errors.js` (`TokenExpiredError`, `ManifestParseError`, `DecryptionError`, `RemuxError`, `DRMProtectedError`, `UnsupportedFormatError`) so the popup can map them to user-friendly messages.

---

## 8. Gotchas / things that will bite you

1. **Short-lived signed tokens** (Hotmart's `hdntl`, Cloudflare/Akamai variants). Treat any download that starts >5 minutes after capture as suspect. If a segment fetch returns 403, surface a "Token expired — reload the page and try again" error rather than retrying blindly.
2. **`credentials: 'include'`** on every fetch from the offscreen document — many sites authenticate segment fetches via cookies. If a site uses `Authorization: Bearer ...` instead, the frame hook will have captured it; apply via the `headers` field on the media entry.
3. **HLS IV derivation**: when `#EXT-X-KEY` omits `IV=`, the IV is the segment's media sequence number as a 16-byte big-endian integer. The sequence number is `EXT-X-MEDIA-SEQUENCE + index_within_playlist` (RFC 8216 §6.2.2). `m3u8-parser`'s `segment.timeline` is the **discontinuity counter** (zero for continuous playlists), not the media sequence — using it silently produces a zero IV on every segment after the first and decrypts to garbage. Default to a zero IV is also wrong for the same reason.
4. **Master vs. media playlist**: `.m3u8` may be either. Detect by presence of `#EXT-X-STREAM-INF` (master) vs. `#EXTINF` (media). Resolve variant URLs relative to the master URL, not the page.
5. **AAC ADTS → ASC**: when remuxing TS→MP4 the AAC frames need ADTS-to-ASC conversion or QuickTime / Safari won't play the audio. mux.js handles this transparently; an ffmpeg path would need `-bsf:a aac_adtstoasc`. Don't ship a path that skips this — silent-audio-on-Safari is the easy regression.
6. **DASH separates tracks**: audio and video are usually independent representations. Fetch both, then mux with `ffmpeg -i video.mp4 -i audio.mp4 -c copy out.mp4`.
7. **DRM detection**: if a DASH MPD has `<ContentProtection>` referencing Widevine (`edef8ba9-79d6-4ace-a3c8-27dcd51d21ed`), PlayReady (`9a04f079-9840-4286-ab92-e65be0885f95`), or FairPlay (`94ce86fb-...`), set `mediaEntry.drm = true` and let the popup show "DRM-protected — cannot download." Don't try to be clever.
8. **MSE / `blob:` video sources**: some sites stream by building a MediaSource and pushing fragments via `SourceBuffer.appendBuffer`. The `<video>` tag's `src` will be `blob:...` — useless. You need the underlying `.m4s` / fragmented MP4 segment fetches, which the frame hook will see. Parked as a post-v1.0 item.
9. **Cross-origin iframe DOM is invisible** to the parent content script. Don't try `iframe.contentDocument` — it's null. All iframe data must come through the frame content script via messages. (This is exactly the Hotmart case.)
10. **`webRequest` in MV3** still works for *observation* (`onBeforeRequest`, `onHeadersReceived`, `onCompleted`) without `webRequestBlocking`. Don't reach for `declarativeNetRequest` — we're not modifying requests, just watching.
11. **Service worker restarts** clear in-memory `Map`s. Persist the detected-media state to `chrome.storage.session` so it survives a SW respawn within the browser session.
12. **Filename sanitization**: strip `/ \ : * ? " < > |`, collapse whitespace, trim to 200 chars. Keep accented characters — many real titles need them.
13. **Never log full URLs.** Signed-token query params are bearer credentials. Always pipe through `redactUrl()`.
14. **Non-http(s) frames** (chrome-extension://, devtools://, view-source:): exclude from both the webRequest filters and the content script matches. They'll either error or surface garbage.
15. **Capture manifest *bodies* from the player's origin**, not from the SW. Akamai-style signed URLs accept the request based on the *referer / origin* of the player iframe; an `chrome-extension://…` origin fetch gets 403'd even with the same `hdntl` token. The frame's main-world hook clones the player's already-successful `fetch` response and posts it to the isolated world, which forwards bytes to the SW. The SW must never re-fetch the manifest itself.
16. **Cross-origin segment fetches use `credentials: 'same-origin'`, not `'include'`**. Many CDNs respond with `Access-Control-Allow-Origin: *`, which the browser refuses to combine with `credentials: 'include'` — the fetch fails with a generic `Failed to fetch`. Auth on these URLs is bearer-in-query (`hdntl`, signature tokens) and does not need the cookie jar.
17. **Segment fetches must run inside the *player iframe's* content script**, not the SW. Same reason as #15: the iframe's origin matches the player, the SW's origin does not. `chrome.tabs.sendMessage(tabId, msg, { frameId })` is the routing tool; `frameId` is captured on `sender.frameId` for messages and `details.frameId` for webRequest.

---

## 8a. mux.js / fragmented-MP4 patching (the v0.7 lessons)

mux.js was built for `SourceBuffer.appendBuffer()` — it expects the player to layer the playback timeline. Writing its output directly to disk surfaces several quirks that all manifest as the same broad symptom (file plays in browsers via MSE but VLC / QuickTime show blank intros, wrong durations, or 13-hour timelines). Each one of these took multiple test downloads to isolate; please don't undo them without reproducing on a real video first.

1. **Per-track moofs are emitted separately even when the data event says `type: 'combined'`.** mux.js's `combined` event carries `[audio_moof + audio_mdat + video_moof + video_mdat]` concatenated — *not* a single moof with two trafs. VLC reads the audio-only first moof as the start of the movie, plays blank video for the duration of that fragment, then re-syncs when it hits the video moof at `tfdt = 0`. The fix in `remux.js` re-packs each data event into one proper movie fragment with `mfhd + audio traf + video traf` followed by a combined `mdat`. This involves rewriting each `trun.data_offset` to point inside the new mdat and setting `tfhd.flags |= 0x020000` (default-base-is-moof). Do not "simplify" this back to passing mux.js output through verbatim — VLC will break.

2. **`mfhd.sequence_number` must be globally monotonic across all moofs.** mux.js counts per-track, so audio moofs and video moofs collide on the same sequence numbers. Renumbering alone (without combining moofs per (1)) is *worse*: VLC starts playback at the wrong offset and freezes. The combined-moof pass in (1) assigns one globally-increasing `sequence_number` per fragment, which is the right fix.

3. **mux.js writes `tfdt.baseMediaDecodeTime = 0` on every fragment.** `setBaseMediaDecodeTime()` controls *internal* shifting; it does not propagate to the emitted box. We post-patch each moof's tfdt in file order using the running per-track cumulative.

4. **Patch tfdt from *emitted content* duration, not from EXTINF.** mux.js's per-fragment content duration is typically slightly shorter than the playlist's `#EXTINF` (because the TS boundary lands a few frames before the declared duration). Patching tfdt from EXTINF accumulates a per-fragment gap; on a 14-minute video this is the difference between "plays perfectly" and "6 seconds of blank at the start, then resync". The correct source is the sum of `trun` sample durations in the moof we just wrote.

5. **`trun.version` must be `1` whenever any sample composition offset is negative.** mux.js writes negative B-frame composition offsets (e.g. `-3060` at 90 kHz) but leaves the trun at `version = 0`, which declares cto as **unsigned**. VLC reads `0xFFFFF40C` as 4 294 964 236 ticks ≈ 47 721 s ≈ **13.26 hours** and pushes the affected sample's PTS into the far future, producing blank playback. The patcher promotes `version` to 1 whenever any cto in the trun has the sign bit set. The on-disk bits don't change — only the reader's interpretation.

6. **`mvhd` / `tkhd` / `mdhd` duration fields must be patched.** mux.js leaves them at `0xFFFFFFFF` (the fMP4 "unknown duration, derive from samples" sentinel). MSE-based players honor the sentinel; VLC reads it literally — `0xFFFFFFFF / 90000 ≈ 47 721 s ≈ 13.26 hours`. We rewrite each duration from the per-track total computed in step (4): `mvhd` and `tkhd` in movie timescale = `longest-track-seconds × movie_timescale`; `mdhd` in the track's own timescale = its sample-duration total. The `tkhd` duration field lives at body offset `+20` (v0) or `+28` (v1); `mvhd` and `mdhd` use `+16` / `+24`. They look identical but the offsets differ — keep the helper functions separate.

7. **Don't pass `keepOriginalTimestamps: true`** to the Transmuxer. With it on, the first fragment's tfdt and PTS reflect the raw HLS timeline (often hundreds of hours into wall-clock time), producing the original 371-hour-duration bug. Default `false` plus per-segment push lets mux.js normalize each segment internally; the patcher in §8a (3) handles the cross-segment timeline.

8. **The whole patching pipeline lives in `extension/offscreen/remux.js`** and has a dedicated regression test (`extension/offscreen/remux.test.js`) asserting `ftyp / moov / moof / mdat / moof / mdat` shape with two trafs per moof. If you change anything in that file, run the test — it's the firewall against re-introducing any of the above bugs.

---

## 9. Testing strategy

- **Unit tests** (`vitest`): m3u8/mpd parsing, IV derivation, filename sanitization, adapter matching priority, message-envelope validation, AES decrypt against fixture key+segment, URL redaction.
- **Integration tests** for the offscreen pipeline using recorded fixtures (a short test course's manifest + 2–3 encrypted segments + key for Hotmart, plus a public DASH-IF reference stream snippet). Redact tokens from fixture URLs before committing.
- **Manual smoke test** before each tagged release: load unpacked, open both a Hotmart lesson and a public HLS test page, capture, download, play the resulting MP4 in VLC and confirm audio + video sync.
- **No real network in CI** — fixtures only.

---

## 10. What NOT to do

- Don't add telemetry, remote config, error reporting, or any "phone home" behavior.
- Don't re-encode video. Stream copy only.
- Don't attempt DRM decryption (Widevine / PlayReady / FairPlay). If a stream is DRM-encrypted, set `drm: true` and show "DRM-protected — cannot download" in the popup row.
- Don't put site-specific logic anywhere except `extension/adapters/`. If you find yourself writing `if (pageUrl.includes('hotmart'))` in core code, that's a bug — extend the adapter contract instead.
- Don't store signed tokens in `chrome.storage` longer than necessary. They're bearer credentials.
- Don't add a backend or hosted service. The extension must work fully offline (apart from the obvious downloads from the target CDN).
- Don't capture URLs from non-http(s) frames (extension pages, devtools, view-source).
- Site adapters may target any site where the user has a legitimate download/use case, including YouTube. Keep the hard boundaries above: no DRM decryption, no backend service, no telemetry, and no site-specific logic outside `extension/adapters/`.

---

## 11. When you're stuck

- The original Hotmart spec is in `plan.txt` — read §6 (Key Technical Considerations) and §7 (Edge Cases) before guessing at behavior. Other adapters should aim for the same level of care.
- The current milestone and checkbox list is in `ROADMAP.md`. Pick up from the first unchecked item under the current version header.
- If a checkbox is ambiguous, prefer the simplest implementation that satisfies it and leaves room for the next milestone.
- If you're tempted to special-case a site in core, stop — write or extend an adapter instead. See §4.

---

## 12. Branching & shipping

- **One branch per version.** When you start a new `v0.x` / `v1.x` milestone, switch to a branch named after that version (e.g. `v0.11-youtube`) before touching code. `main` should always be in a shippable state and never carry half-built milestones.
- Branch name format: `v<version>-<short-slug>` (e.g. `v0.11-youtube`, `v0.12-hls-completeness`). The slug matches the ROADMAP header.
- Tactical fixes that aren't part of a milestone (a bug fix, a typo) can land directly on `main`.
- Merge the version branch into `main` only when the milestone's ship criterion is met and `npm run check` is green.
- Within a milestone, commit in coherent slices (one architectural change per commit) rather than one giant blob — the recent v0.10 history is a reasonable reference for granularity.
