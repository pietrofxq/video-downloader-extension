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
| Media remux | **ffmpeg.wasm** (`@ffmpeg/ffmpeg`, `@ffmpeg/core`) | MPEG-TS → MP4 stream-copy, and audio+video mux for DASH. **Never re-encode.** |
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
│  • Forwards URLs + headers  │     │  • ffmpeg.wasm remux to MP4      │
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
Service workers in MV3 are killed after ~30s idle and cannot hold large blobs reliably. ffmpeg.wasm needs WASM + Workers + persistent memory. The **offscreen document** (`chrome.offscreen.createDocument`) is the MV3-sanctioned escape hatch for exactly this kind of work. Always tear it down after a download with `chrome.offscreen.closeDocument()` to free memory.

### Why the adapter pattern
Hotmart needs a cross-origin iframe scraper, signed-token handling, and a specific filename template. A second site (Vimeo, Bunny CDN, generic Video.js) will need a *different* set of three things. The adapter pattern keeps core code generic and pushes site oddities into ~50-line files that can be added or removed without touching the engine. The matching contract is also what makes the popup's per-row "adapter badge" possible.

### Why stream-copy remux (no re-encoding)
The source is almost always already H.264 + AAC. `ffmpeg -i in.ts -c copy -bsf:a aac_adtstoasc out.mp4` is ~50× faster than re-encoding and lossless. **Never** add `-c:v libx264` or similar — re-encoding in WASM is unusable for long videos.

### Why OPFS for large downloads
Holding 1–2 GB of concatenated TS data in JS memory is fragile in Chrome. For anything over ~500 MB, write decrypted segments to OPFS in the offscreen document, mount that into ffmpeg.wasm's virtual FS, then read back the MP4. Below the threshold, in-memory `Uint8Array` concatenation is fine and faster.

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
3. **HLS IV derivation**: when `#EXT-X-KEY` omits `IV=`, the IV is the segment's media sequence number as a 16-byte big-endian integer. Don't default to a zero IV — it will decrypt to garbage.
4. **Master vs. media playlist**: `.m3u8` may be either. Detect by presence of `#EXT-X-STREAM-INF` (master) vs. `#EXTINF` (media). Resolve variant URLs relative to the master URL, not the page.
5. **AAC ADTS → ASC**: when remuxing TS→MP4 you MUST pass `-bsf:a aac_adtstoasc` or QuickTime/Safari won't play the audio.
6. **DASH separates tracks**: audio and video are usually independent representations. Fetch both, then mux with `ffmpeg -i video.mp4 -i audio.mp4 -c copy out.mp4`.
7. **DRM detection**: if a DASH MPD has `<ContentProtection>` referencing Widevine (`edef8ba9-79d6-4ace-a3c8-27dcd51d21ed`), PlayReady (`9a04f079-9840-4286-ab92-e65be0885f95`), or FairPlay (`94ce86fb-...`), set `mediaEntry.drm = true` and let the popup show "DRM-protected — cannot download." Don't try to be clever.
8. **MSE / `blob:` video sources**: some sites stream by building a MediaSource and pushing fragments via `SourceBuffer.appendBuffer`. The `<video>` tag's `src` will be `blob:...` — useless. You need the underlying `.m4s` / fragmented MP4 segment fetches, which the frame hook will see. Parked as a post-v1.0 item.
9. **Cross-origin iframe DOM is invisible** to the parent content script. Don't try `iframe.contentDocument` — it's null. All iframe data must come through the frame content script via messages. (This is exactly the Hotmart case.)
10. **`webRequest` in MV3** still works for *observation* (`onBeforeRequest`, `onHeadersReceived`, `onCompleted`) without `webRequestBlocking`. Don't reach for `declarativeNetRequest` — we're not modifying requests, just watching.
11. **Service worker restarts** clear in-memory `Map`s. Persist the detected-media state to `chrome.storage.session` so it survives a SW respawn within the browser session.
12. **Filename sanitization**: strip `/ \ : * ? " < > |`, collapse whitespace, trim to 200 chars. Keep accented characters — many real titles need them.
13. **Never log full URLs.** Signed-token query params are bearer credentials. Always pipe through `redactUrl()`.
14. **Non-http(s) frames** (chrome-extension://, devtools://, view-source:): exclude from both the webRequest filters and the content script matches. They'll either error or surface garbage.

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
- Don't ship adapters for sites whose ToS unambiguously forbid downloads (e.g. YouTube). Stick to sites where there's a legitimate user-owns-the-content use case.

---

## 11. When you're stuck

- The original Hotmart spec is in `plan.txt` — read §6 (Key Technical Considerations) and §7 (Edge Cases) before guessing at behavior. Other adapters should aim for the same level of care.
- The current milestone and checkbox list is in `ROADMAP.md`. Pick up from the first unchecked item under the current version header.
- If a checkbox is ambiguous, prefer the simplest implementation that satisfies it and leaves room for the next milestone.
- If you're tempted to special-case a site in core, stop — write or extend an adapter instead. See §4.
