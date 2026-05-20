# ROADMAP

Shippable milestones for the Video Downloader extension. Each version is independently demoable — at the end of a version you should be able to load the extension unpacked and *show something working*.

The engine is **site-agnostic**: generic media detection runs everywhere, and a **site-adapter** layer adds richer metadata, auth handling, and naming for specific origins. **Hotmart Club is the first and most-tested adapter** — its needs (cross-origin iframe, signed `hdntl` token, AES-128 segments) drive a lot of the design, but no Hotmart-specific code lives outside `extension/adapters/hotmart.js`. Adding another adapter (Vimeo, generic Video.js, Bunny CDN, etc.) is intentionally a small, well-scoped task — see v1.4.

A coding agent picking up work should:
1. Find the lowest unchecked version section.
2. Complete its checkboxes top-to-bottom.
3. Tick each box as the work lands, then move on.
4. Don't skip ahead - later versions assume earlier ones are done.

UI inspiration: **Video DownloadHelper** (`lmjnegcaeklhafolokijcfjliaokphfk`) — a popup that lists detected media items as rows, each with title / quality badge / size / per-row action button, plus a toolbar badge counter when items are detected. Mirror that pattern.

---

## v0.1 — Skeleton extension (loads, does nothing useful)

Goal: an unpacked extension Chrome will accept, with all five contexts wired up and exchanging hello messages, plus the adapter scaffold in place from day one.

- [x] Create `extension/manifest.json` with:
  - `host_permissions`: `["<all_urls>"]` (required to fetch arbitrary segments from the offscreen doc and observe webRequest across origins).
  - Content-script matches: `["http://*/*", "https://*/*"]` for both `page-content.js` (top frame) and `frame-content.js` (`all_frames: true`, `run_at: document_start`).
  - Permissions: `storage`, `downloads`, `webRequest`, `scripting`, `tabs`, `offscreen`.
- [x] Add placeholder icons (16/32/48/128 PNG) to `extension/icons/`.
- [x] Create `extension/background/service-worker.js` that logs `"SW alive"` on install.
- [x] Create `extension/content/page-content.js` (top frame) that sends a `PING` message on load.
- [x] Create `extension/content/frame-content.js` (all frames, `document_start`) that sends a `PING` message on load.
- [x] Create `extension/popup/popup.html` + `popup.js` rendering a static "Video Downloader" header.
- [x] Create `extension/offscreen/offscreen.html` + `offscreen.js` (stub; not yet spawned).
- [x] Create `extension/adapters/index.js` exporting `pickAdapter(pageUrl, mediaUrl)` plus an `ORDERED` array.
- [x] Create `extension/adapters/default.js` (stub; `matches` always true).
- [x] Create `extension/adapters/hotmart.js` (stub; `matches` for `hotmart.com/*/club/*`).
- [x] Set up `package.json` with `esbuild` and an `npm run build` script that bundles content scripts to IIFE and copies static assets to `dist/`.
- [x] Add `.eslintrc` (flat config) and `.prettierrc`; wire `npm run lint` and `npm run format`.
- [x] Add a minimal `lib/log.js` with `redactUrl()` stripping `hdntl`, `token`, `signature`, `Policy`, `Signature`, `Key-Pair-Id` query params.
- [x] Verify: load `dist/` unpacked, open any page, confirm the SW logs pings from both content scripts; open a Hotmart Club lesson and confirm the `hotmart` adapter is picked.

**Ship criterion:** extension loads with no manifest errors; pings appear in the SW console on any site; adapter selection works.

---

## v0.2 — Generic network capture (HLS / DASH / progressive)

Goal: when the user presses play on any site, the service worker captures the manifest URL and tags it with the matching adapter.

- [x] In `service-worker.js`, register `chrome.webRequest.onBeforeRequest` matching `*://*/*.m3u8*`, `*://*/*.mpd*`, `*://*/*.mp4*`, `*://*/*.webm*`. Also observe `*.key*` and `*.m4s*` segment requests.
- [x] Use `chrome.webRequest.onHeadersReceived` to read `Content-Type` for ambiguous extensions; tag each detection with `kind: 'hls' | 'dash' | 'progressive'`.
- [x] Maintain an in-memory `Map<tabId, MediaEntry[]>` where `MediaEntry = { id, kind, url, pageUrl, adapterId, capturedAt, headers?, meta? }`.
- [x] Mirror that map to `chrome.storage.session` so it survives SW respawn.
- [x] In `frame-content.js`, monkey-patch `window.fetch` and `window.XMLHttpRequest` at `document_start`:
  - Forward URLs matching the same patterns via `MEDIA_URL_DETECTED`.
  - Capture custom headers from `XHR.setRequestHeader` and `fetch(init.headers)`; include them in the payload.
- [x] In the SW, for every detection call `pickAdapter(pageUrl, mediaUrl)` from `adapters/index.js` and attach the resulting `adapterId` (`'hotmart'` on Hotmart, `'default'` elsewhere).
- [x] Dedupe by URL within a tab; ignore non-http(s) frames.
- [x] Update the toolbar badge text to the count of detected media for the active tab; clear it on tab close / navigation.
- [x] Set badge background color to a distinct color (e.g. `#ff5d2e`) when count > 0.
- [x] Verify on Hotmart: play a lesson; badge shows ≥1; SW console shows the manifest URL (`hdntl` redacted) with `adapterId: 'hotmart'`.
- [x] Verify elsewhere: open a public HLS test page (e.g. an Mux or HLS.js demo); badge shows ≥1; entry has `adapterId: 'default'` and `kind: 'hls'`.
- [x] Verify with DASH: open a DASH-IF reference stream; entry has `kind: 'dash'`.

**Ship criterion:** badge counter increments on play across multiple unrelated sites; each detection carries an adapter id and a media kind.

---

## v0.3 — Site metadata via adapters

Goal: detected media has human-readable metadata on every site, with adapters supplying better data when available.

- [x] Define the **Adapter contract** in `lib/adapter.js` (JSDoc): `{ id, matches(pageUrl, mediaUrl), scrapePageMeta(document), observe(document, onUpdate)?, deriveFilename({ pageMeta, url, mediaEntry }), transformHeaders(headers)? }`.
- [x] Implement `adapters/default.js`:
  - `matches`: always true.
  - `scrapePageMeta`: returns `{ title: document.title, ogTitle, ogVideoTitle }`.
  - `deriveFilename`: returns sanitized `{title} - {urlBasename}`.
- [x] Implement `adapters/hotmart.js`:
  - `matches`: `pageUrl` host is `hotmart.com` and path includes `/club/`.
  - `scrapePageMeta`: scrapes lesson `h1`, section line above, and `cur` filename from iframe `src`.
  - `observe`: `MutationObserver` on the lesson container that re-invokes `onUpdate` on SPA navigation.
  - `deriveFilename`: returns sanitized `{sectionTitle} - {lessonTitle}`.
- [x] In `page-content.js`, on `document_idle`: load the matched adapter, call its `scrapePageMeta`, send `PAGE_META` with `{ tabId, adapterId, meta }`. Wire up `observe` so SPA navs send fresh `PAGE_META` messages.
- [x] In the SW, merge `meta` onto every `MediaEntry` for the tab that shares the same `adapterId` (and the default adapter for any without a more specific one).
- [x] Add `lib/sanitize-filename.js` (strip illegal chars, trim, collapse whitespace, keep accents).
- [x] Verify on Hotmart: navigate between two lessons; SW state updates with the new title each time.
- [x] Verify on a non-Hotmart site: page title appears as the metadata; filename derived from page title + URL basename.

**Ship criterion:** every detected `MediaEntry` has a meaningful title; navigating between SPA pages keeps it fresh.

---

## v0.4 — Popup UI: list detected media (Video DownloadHelper-style)

Goal: clicking the toolbar icon shows a clean list of detected media for the current tab, with adapter badge, quality, and a (non-functional) Download button.

UI layout (mirror Video DownloadHelper rows, one row per detected stream):

```
┌─────────────────────────────────────────────────┐
│ Video Downloader                          ⚙     │
├─────────────────────────────────────────────────┤
│ ▶ Porta de Entrada               [hotmart]      │
│   Lição 3, Lição 4 e Lição 5                    │
│   PE-A4.mp4 · HLS · AES-128                     │
│   Quality [ 1080p (3241 kbps) ▼ ]   [Download ↓]│
├─────────────────────────────────────────────────┤
│ ▶ Big Buck Bunny                  [default]     │
│   example.com/player                            │
│   bbb_master.m3u8 · HLS                         │
│   Quality [ 1080p (5000 kbps) ▼ ]   [Download ↓]│
├─────────────────────────────────────────────────┤
│ ▶ Sample DASH stream              [default]     │
│   dash.akamaized.net                            │
│   manifest.mpd · DASH                           │
│   Quality [ 720p (2500 kbps)  ▼ ]   [Download ↓]│
├─────────────────────────────────────────────────┤
│ Include subtitles ☐                            │
└─────────────────────────────────────────────────┘
```

Empty state:
```
┌─────────────────────────────────────────────────┐
│ Video Downloader                          ⚙     │
├─────────────────────────────────────────────────┤
│ No videos detected on this tab.                 │
│                                                 │
│ Press play on a video for ~2 seconds, then      │
│ reopen this popup.                              │
└─────────────────────────────────────────────────┘
```

- [x] Build `popup.html` + `popup.css` matching the layout above (rows, 360–400px wide).
- [x] On popup open, send `GET_TAB_STATE` to the SW and render the response. (Implemented as `chrome.runtime.connect({name:'popup'})` + `SUBSCRIBE` — SW replies with the initial state, then pushes on every change. Replaces the v0.2 sendMessage broadcast that fanned out to every listener.)
- [x] One row per `MediaEntry`: show title (from adapter meta), source host/section, filename, format badges (HLS / DASH / progressive, AES-128, ClearKey, DRM if flagged), and the **adapter id as a small pill** in the top-right of the row.
- [x] Quality dropdown is a placeholder until v0.5 parses the manifest — show a single "auto" option.
- [x] "Download" button is wired to a no-op handler that logs the row's `mediaId` + `adapterId`.
- [x] If `mediaEntry.drm === true`, disable the Download button and replace it with a "DRM-protected" label.
- [x] Settings gear icon opens `options.html` (placeholder page).
- [x] When the popup is open, subscribe to SW push updates (`TAB_STATE_UPDATED`) so newly detected videos appear without a manual reopen.
- [x] Verify: open Hotmart lesson + a public HLS demo in two tabs; each popup shows the correct rows tagged with the matching adapter.

**Ship criterion:** popup shows real metadata for every detected video on the current tab, on any supported site.

---

## v0.5 — Parse m3u8 + populate quality picker

Goal: the quality dropdown shows real HLS variants from the master playlist.

- [x] Add `m3u8-parser` to `vendor/` and bundle via esbuild. (Installed as a regular dep; esbuild auto-bundles.)
- [x] In the SW (or a helper module loaded into the popup), fetch the manifest with `credentials: 'include'` plus any captured `headers` from the `MediaEntry`. (`lib/manifest-fetch.js` + adapter's `transformHeaders`.)
- [x] Detect master vs. media playlist by inspecting `#EXT-X-STREAM-INF` vs. `#EXTINF`. (m3u8-parser's `manifest.playlists` vs `manifest.segments`.)
- [x] If master: list each variant as `{ resolution, bandwidth, url }`; sort descending by bandwidth.
- [x] If media: synthesize a single "auto" variant. (Popup renders "Single quality" option for `isMaster: false` entries.)
- [x] Render variants in the popup dropdown; default selection = highest bandwidth. (First option = highest after sort.)
- [x] Cache the parsed manifest in the SW map entry to avoid re-fetching on popup reopen (respect token expiry — invalidate after 4 minutes for entries whose URL contains a known signing param). (Cached on the MediaEntry as `variants` + `isMaster`. Token-expiry-aware invalidation deferred to v0.6's download flow where token-expiry errors are typed as `TokenExpiredError`; v0.5's cache lives only until tab navigation clears it.)
- [x] Verify on Hotmart: dropdown shows e.g. `1080p (3241 kbps) / 720p (1280 kbps) / 480p (640 kbps)`.
- [x] Verify on a public HLS test stream: dropdown lists the test stream's variants.

**Ship criterion:** popup quality dropdown is populated from a real manifest fetch on any HLS site.

---

## v0.6 — Segment download + AES-128 decrypt (HLS)

Goal: clicking Download produces a playable `.ts` file (not MP4 yet) saved to disk, for any HLS stream.

- [x] Add `lib/errors.js` with `TokenExpiredError`, `ManifestParseError`, `DecryptionError`, `RemuxError`, `DRMProtectedError`, `UnsupportedFormatError`. (Stub from v0.1; v0.6 wires the three HLS-relevant ones into `offscreen/downloader.js`.)
- [x] Implement `chrome.offscreen.createDocument` spawning from the SW with reason `BLOBS` + `WORKERS`. (`ensureOffscreen()` memoizes; document stays alive across downloads so Blob URLs survive the download window.)
- [x] In `offscreen.js`, on receiving `START_DOWNLOAD`:
  - Fetch the chosen variant playlist using `credentials: 'include'` + any captured `headers` (some sites use `Authorization: Bearer ...`). (Routed through frame proxy — `credentials: 'same-origin'` in the content-script context, since cross-origin Akamai CDNs send `Access-Control-Allow-Origin: *` and reject `include`.)
  - Extract AES key URL + IV (derive from sequence number when `IV=` is absent).
  - Fetch the key (16 bytes) once. (Cached per key URL in case of mid-stream rotation.)
  - Fetch segments with a concurrency limit of 4, applying the same headers.
  - Decrypt each segment with Web Crypto `AES-CBC` using key + per-segment IV.
  - Concatenate decrypted segments into a `Blob` (in memory for <500 MB; OPFS-backed otherwise). (In-memory for v0.6; OPFS path deferred until first user hits a multi-GB lesson.)
- [x] Send `DOWNLOAD_PROGRESS` after each segment with `{ stage: 'fetch'|'decrypt', current, total }`. (Plumbed; popup rendering lands in v0.8.)
- [x] On completion, hand back a Blob URL to the SW, which calls `chrome.downloads.download({ url, filename, saveAs: false })`.
- [x] Filename comes from the matched adapter's `deriveFilename({ pageMeta, url, mediaEntry })` + `.ts`.
- [x] Detect 403 responses and throw `TokenExpiredError`; popup shows "reload the page" message. (Mapping is in `offscreen/downloader.js` `throwFromReply`; user-visible message is v0.8.)

Architectural addition (didn't survive contact with reality): all segment / key / variant-playlist fetches go through the **frame proxy** (`PROXY_FETCH` to the content script in the player's iframe origin) — SW fetches from `chrome-extension://…` origin get 403'd by signed-URL CDNs (Hotmart, etc.). The same body-capture pattern from v0.5's manifest detection now applies here through a deliberate fetch from the right origin.
- [x] Verify on Hotmart: download a short lesson; resulting `.ts` plays in VLC with correct video and audio.
- [x] Public-HLS smoke coverage moved into v0.8.1 hardening, where the output target is now `.mp4` instead of the old v0.6 `.ts` artifact.

**Ship criterion:** any HLS stream downloads end-to-end as a decrypted `.ts` and plays in VLC.

---

## v0.7 — mux.js remux to MP4

Goal: the saved file is `.mp4` (H.264 + AAC, stream copy, plays in QuickTime/Chrome/VLC).

Implementation note: the roadmap originally specified ffmpeg.wasm. After
looking at the actual implementation needs — HLS H.264+AAC TS → fragmented
MP4 with no re-encoding — `mux.js` (the same transmuxer videojs/HLS.js use
internally) is a much better fit. 150 KB JS vs 25+ MB WASM, no
SharedArrayBuffer/COOP/COEP setup, no virtual FS. We retain the option to
swap in ffmpeg.wasm later if we ever need re-encoding, audio-only mux, or
subtitle muxing.

- [x] Add `mux.js` as a dependency; esbuild bundles it into the offscreen entry. (No `vendor/` copy needed; the bundle handles it.)
- [x] In `offscreen/remux.js`, drive a `muxjs.mp4.Transmuxer({ remux: true })` per-segment (push + flush with running `setBaseMediaDecodeTime`), normalize each emitted data event into a single moof-with-two-trafs fragment, then patch the moov / moof boxes (tfdt, durations, signed cto, mfhd seq). See `AGENTS.md` §8a for why every step is necessary. (`keepOriginalTimestamps: true` was the original plan and caused the 371-hour-duration bug — do **not** re-introduce it.)
- [x] In-memory remux for v0.7. OPFS-backed path deferred until we hit a multi-GB lesson (the same threshold we set for the TS concat step).
- [x] Report progress stage `remux` while mux.js runs. (Plumbed; popup rendering still lands in v0.8.)
- [x] Change the saved filename to the adapter-derived name + `.mp4`. Blob MIME changed to `video/mp4`.
- [x] Keep the offscreen document alive for v0.7 so Blob URLs survive the download handoff; full offscreen lifecycle + memory cleanup moved into v0.10's download-engine milestone.
- [x] Verify on Hotmart: downloaded MP4 plays cleanly in VLC with audio + video sync, accurate duration, no blank intro, working seek. (ffprobe + repaired-copy comparison confirmed correct fragment layout.)

**Ship criterion:** any HLS download produces a clean `.mp4` that plays in QuickTime and Chrome.

---

## v0.8 — Progress UI + error states

Goal: the popup shows live progress and friendly errors during a download.

- [x] Add a progress bar component to the popup row: `███████░░░ 70% · segment 21/30 · decrypting`.
- [x] Subscribe to `DOWNLOAD_PROGRESS` and update the bar per message. (Wired via per-port `DOWNLOAD_STATE` push from the SW, with the SW as authoritative state holder.)
- [x] On `DOWNLOAD_DONE`, replace the bar with a green "Saved" pill + a "Show in folder" link calling `chrome.downloads.show(downloadId)`.
- [x] On `DOWNLOAD_ERROR`, show a red inline message mapped from the typed error:
  - `TokenExpiredError` → "Token expired. Reload the page and try again."
  - `ManifestParseError` → "Couldn't read the video manifest."
  - `DecryptionError` → "Decryption failed. Try reloading the page."
  - `RemuxError` → "Couldn't repackage the video."
  - `DRMProtectedError` → "This stream is DRM-protected and can't be downloaded."
  - `UnsupportedFormatError` → "Unsupported stream format."
- [x] Persist the in-progress download state in the SW so closing+reopening the popup mid-download still shows the live bar. (`downloadStates` Map in the SW; replayed on every popup `SUBSCRIBE`. In-memory only — the SW stays warm during an active download because the offscreen sends a progress message per segment.)
- [x] Verify: progress bar updates per segment, "Saved" pill + "Show in folder" land on success, popup close+reopen mid-download still shows the live bar. (Error-path matrix — expire token / corrupt manifest / DRM flag — deferred to ad-hoc verification when each path is exercised in the wild; the mapping is exhaustive over the typed errors `lib/errors.js` exports.)

**Ship criterion:** a user can watch a download progress in real time and gets a useful message on every failure path.

---

## v0.8.1 - HLS/MP4 hardening

Goal: close correctness holes in the current HLS-to-MP4 path before adding more formats.

- [x] Fix explicit `EXT-X-KEY:IV=` handling: `m3u8-parser` exposes IVs as `Uint32Array`; serialize each word big-endian before AES-CBC decrypting. Add a parser-backed test for `IV=0x00000000000000000000000000000001`. (Landed in `71a49d3` post-v0.7 review.)
- [x] Normalize every URL observed by the MAIN-world fetch/XHR hooks with `new URL(url, location.href).href` before posting it to the isolated-world bridge. This lets captured manifest bodies match SW-stored absolute URLs. (Landed in `71a49d3` post-v0.7 review.)
- [x] Reject unsupported HLS encryption methods explicitly. `AES-128` is supported; `NONE` is pass-through; `SAMPLE-AES`/`SAMPLE-AES-CTR` raise `DRMProtectedError`, anything else raises `UnsupportedFormatError`. The gate scans the raw playlist text *before* m3u8-parser — the parser silently drops non-AES-128 keys (returning `seg.key = undefined`), which would otherwise let us treat encrypted segments as plain TS.
- [x] Add fixture-based integration tests for:
  - unencrypted public HLS media playlist
  - AES-128 with implicit IV from media sequence
  - AES-128 with explicit IV
  - malformed/HTML manifest response
  - unsupported encryption method
- [x] Add an MP4 probe helper for local manual verification (`scripts/probe-mp4.mjs`, run via `npm run probe-mp4 <file.mp4>`). Prints the box tree and flags non-monotonic `mfhd.sequence_number` plus per-moof traf counts so the v0.7 regressions ("blank intro then resync") get caught immediately.
- [x] Make `npm run format:check` a release gate. New `npm run check` runs format-check → lint → test → build and is what we should run before tagging.
- [x] Replace committed popup `console.*` calls with `lib/log.js`. (Offscreen was migrated in the v0.7 review; popup remained on eslint-disabled `console.*` until now. `lib/log.js` already redacts URLs + sensitive params, so the popup auto-inherits redaction.)
- [ ] Manual smoke test matrix:
  - Hotmart AES-128 HLS lesson
  - public unencrypted HLS demo
  - explicit-IV HLS fixture
  - playback in VLC, Chrome, and QuickTime where available

**Ship criterion:** the current HLS MP4 pipeline is verified on encrypted and unencrypted streams, rejects unsupported HLS cleanly, and passes test/lint/format/build.

---

## v0.9 - TypeScript migration

Goal: migrate before the adapter/message/download APIs grow further, so new features land on typed contracts instead of loose JSDoc.

- [x] Add `typescript`, Chrome extension types, and `tsconfig.json` targeting Chrome 120 + ES2022.
- [x] Add scripts:
  - `npm run typecheck`
  - `npm run check` = format check + lint + typecheck + tests + build
- [x] Update esbuild to accept `.ts` entry points and keep content scripts bundled as IIFEs. (build.mjs resolves each entry to `.ts` first then `.js`; output filenames stay `.js` since the manifest references them by that name.)
- [x] Define shared domain types in `extension/lib/types.ts`: `MediaKind`, `MediaEntry`, `PageMeta`, `ParsedHlsManifest`, `HlsVariant`, `HlsAlternate`, `DownloadRequest`, `DownloadOutcome`, `DownloadStatus`, `DownloadStage`, `DownloadState`, `AdapterId`, `Adapter`.
- [x] Replace ad-hoc message payloads with discriminated unions keyed by `MSG.*` (`extension/lib/messages.ts`). Each handler switches on `msg.type` and TS narrows to the right payload — no `as`-casts at receive sites.
- [x] Convert low-risk shared modules: `lib/errors`, `lib/base64`, `lib/sanitize-filename`, `lib/log`, `lib/media-detection`, `lib/m3u8`, `lib/manifest-fetch`, `lib/concurrency`, `lib/media-store`, `lib/entry-filter`, `lib/dom-utils`.
- [x] Convert adapters with the exported `Adapter` interface from `lib/types.ts`. Implementations type all five method members.
- [x] Convert runtime contexts: service-worker, offscreen + downloader + hls-decrypt + remux, popup, page-content + frame-content + main-world-hooks.
- [x] Strict flags on: `strict: true`, `noImplicitReturns: true`, `noFallthroughCasesInSwitch: true`. (`noUncheckedIndexedAccess` deferred — the MP4 box walkers in remux.ts read indexed `buf[off]` heavily and the flag would force null-guards on every byte; revisit when those walkers get refactored into a tighter API.)
- [x] All 13 test files converted to `.ts` and run against the typed modules.

**Ship criterion:** all extension source is TypeScript, `npm run check` is green, and future adapter/message/download changes require typed contracts.

---

## v0.10 - Storage and download engine

Goal: make large downloads predictable instead of relying on one giant JS heap pipeline.

- [x] Introduce an OPFS-backed download workspace in the offscreen document:
  - [x] decrypted HLS segments (`extension/offscreen/storage.ts` writes each segment to `/vdl-workspaces/<requestId>/seg-NNNNNN.ts`; the downloader streams them back via `RemuxSegmentSource`). Heap bound during fetch+decrypt is SEGMENT_CONCURRENCY × max-segment-size (~16–32 MB).
  - [x] intermediate remux buffers (`remuxTsToMp4ToOpfs` in `extension/offscreen/remux.ts`). mux.js fragments stream straight into an OPFS file as they emit; only the init segment + small moof headers stay in JS heap for the tfdt / mvhd / cto patches, which run on a sub-MB in-memory buffer and write back to OPFS via positioned writes. chrome.downloads reads the result from a File-backed Blob URL, so the full MP4 is never materialized in memory. Workspace dispose is deferred to REVOKE_BLOB so the OPFS file stays alive across the SW handoff.
  - [ ] subtitle sidecars later (slots in once v0.9-deferred subtitle support lands)
  - [x] cleanup metadata per request (`workspace.dispose()` in the downloader's finally; idempotent on success / error / abort)
- [ ] Set size thresholds for in-memory vs OPFS paths. Small downloads can stay in memory; larger lessons must spill to OPFS before remux. (Deferred — v0.10 always uses OPFS for simplicity. The I/O overhead is dwarfed by network latency, and skipping the threshold removes a branch that would otherwise need its own fixture coverage. Revisit if profiling shows OPFS hurts on <100 MB downloads.)
- [x] Add a single-download queue or explicit concurrency limit. Phase C: SW serializes via `activeRequestId` + `downloadQueue`; popup shows a "Queued" pill with cancel.
- [x] Add cancellation. Phase A:
  - [x] popup cancel button (× on in-flight rows + queued rows)
  - [x] `AbortController` for proxy fetches (offscreen tracks one per requestId; aborted on CANCEL_DOWNLOAD)
  - [x] offscreen cleanup of partial OPFS files (workspace.dispose() in the finally block fires on abort too)
  - [x] download state transitions to canceled (DownloadStatus += 'canceled'; SW transitions synchronously on the cancel click)
- [x] Add retry policy for transient segment failures. Phase B:
  - [x] retry 429/5xx/network errors with bounded backoff (500ms · 1s · 2s · 4s + ≤300ms jitter, max 4 attempts ≈ ~7.5s)
  - [x] do not retry 403 token-expired failures blindly (`isRetryableReply` allowlist; 403 short-circuits via `throwFromReply` → `TokenExpiredError`)
  - [x] keep per-segment failure context for error messages (`throwFromReply` now appends `(HTTP <status>)`; the segment URL is in the message)
- [x] Close the offscreen document after all active downloads finish and Blob URLs are revoked, with an idle grace period so back-to-back downloads are cheap. Phase F: `scheduleIdleTeardown()` arms a 30s timer when no in-flight / queued state and no outstanding blob URLs remain.
- [x] Persist enough state in `chrome.storage.session` to recover the UI after a service-worker restart while the offscreen document is still active. Phase E: `downloadStates` + `downloadQueue` mirrored on every mutation; SW startup restores both and re-derives `activeRequestId` from the restored statuses.
- [x] Add temp-file cleanup on extension startup/offscreen startup to remove abandoned OPFS workspaces. Phase D: `OpfsWorkspace.cleanupAllStale()` runs fire-and-forget when the offscreen module loads.

**Ship criterion:** a long lesson can download without unbounded JS heap growth, the user can cancel safely, and retry/cleanup behavior is deterministic.

---

## v0.11 - YouTube support

Goal: download YouTube videos end-to-end as the second real adapter. YouTube uses DASH-style adaptive streams (separate audio + video) on `videoplayback?...` URLs plus a small set of progressive single-stream itags, *not* HLS — so v0.11 brings parts of the v1.2 DASH and v1.3 progressive milestones forward for one site rather than depending on the HLS completeness work (parked in v0.12).

Constraints to acknowledge up front:
- **`n`-param throttling.** YouTube applies a per-request "n" parameter; unless the value is re-signed by an obfuscated JS function pulled from `base.js`, segment fetches are throttled to ~50–100 KB/s. The fix is real engineering (extracting + evaluating YouTube's JS function in a sandboxed context) and may slip to v0.11.1. Until it lands, low-bitrate itags are typically less throttled and the docs should call this out.
- **Most YouTube content is non-DRM.** Rentals, Movies & TV purchases, and some music videos use Widevine; existing v0.6 DRM detection already flags those as `DRM-protected`.
- **Live streams** are out of scope (same place HLS live is parked).
- **Age-gated / region-locked** content is out of scope for v0.11; would need cookie / auth handling beyond the existing header capture.

Tasks:

- [ ] webRequest patterns + URL classification: detect `*://*.googlevideo.com/videoplayback*` URLs and classify them via the `mime=` query param (no clean file extension). Tag with `kind: 'progressive'` for muxed itags and `kind: 'dash'` for adaptive video/audio streams.
- [ ] `adapters/youtube.ts`: `matches` on `youtube.com/watch*`, `youtu.be/*`, `youtube.com/embed/*`; `scrapePageMeta` reads `<title>` / `<meta property="og:title">` / channel name and parses `ytInitialPlayerResponse` for `videoDetails` (videoId, title, lengthSeconds, channelTitle).
- [ ] Enumerate formats from `ytInitialPlayerResponse.streamingData` (`formats[]` for progressive itags, `adaptiveFormats[]` for DASH-style streams). Surface them in the popup quality picker with resolution + codec + filesize (YouTube declares contentLength when available — no estimation needed).
- [ ] Progressive single-stream path (cheapest win — covers `itag=18` 360p MP4 + `itag=22` 720p MP4 where present). Stream the chosen URL straight to OPFS with the v0.10 download workspace; no remux needed since these are already MP4 with audio+video muxed. Implementation extracted into `lib/progressive-download.ts` so v1.3's broader progressive milestone just lights it up for arbitrary sites.
- [ ] Adaptive HD path: fetch the chosen video adaptiveFormat + the default audio adaptiveFormat in parallel; combine into one MP4. Both are fMP4 (init segment + media segments), so the mux step layers two tracks rather than the HLS TS→fMP4 transmux v0.7 added. This work also unlocks the HLS alt-audio + fMP4/CMAF cases parked in v0.12 — keep the muxer module agnostic to format origin.
- [ ] `n`-param throttling: spike a solver that extracts the `n` transform from `base.js` and re-signs URLs before they leave the SW. If feasible inside a single milestone, land it; otherwise document the limitation in the README and aim for v0.11.1.
- [ ] DRM handling: if `playabilityStatus.status !== 'OK'` or `streamingData` is empty, the player is gated (DRM, age-restricted, region-locked, members-only). Flag the entry's `drm: true` so the existing popup label fires; do not attempt any download.
- [ ] Filename: adapter's `deriveFilename` returns sanitized `{channelTitle} - {videoTitle}.mp4` (so files group together in the user's downloads when they grab a series).
- [ ] Verify: download a public non-DRM video at 360p (progressive) and 1080p (adaptive) — both play in VLC + QuickTime with audio/video sync and accurate duration.
- [ ] Verify: SPA navigation between watch pages updates the popup metadata each time.
- [ ] Verify: a DRM-gated YouTube rental shows as DRM-protected and the Download button is replaced.
- [ ] Verify: `npm run check` passes; YouTube adapter unit tests cover format enumeration + DRM detection on saved fixture HTML.

**Ship criterion:** a public non-DRM YouTube video downloads to a playable MP4 at the user's chosen quality. If `n`-throttling isn't solved in this milestone the README documents the limitation honestly and points to v0.11.1.

---

## v0.12 - HLS completeness

Goal: make the HLS claim accurate before calling the extension broadly usable. Parked behind v0.11 so YouTube support ships first; the muxer module v0.11 introduces also lights up the alt-audio + fMP4 work below.

- [ ] Support HLS alternate-audio renditions. When a master playlist declares `EXT-X-MEDIA TYPE=AUDIO` separate from the video variant, fetch the default/chosen audio rendition alongside the video, transmux both, and combine them into one MP4.
- [ ] Surface audio rendition choice in the popup only when multiple meaningful audio tracks exist; otherwise choose the manifest default.
- [ ] Handle `EXT-X-DISCONTINUITY`:
  - reset timestamp expectations where required
  - preserve correct `tfdt` continuity in the emitted MP4
  - add discontinuity fixtures
- [ ] Decide and implement the `EXT-X-MAP`/CMAF path:
  - either support fMP4 HLS by concatenating/remuxing init+media fragments correctly
  - or detect it early and show a clear `UnsupportedFormatError`
- [ ] Verify AES-128 key rotation across segments; cache by key URL but respect per-segment key changes and IVs.
- [ ] Detect live/event playlists and either:
  - snapshot only the current VOD-like segment window with a clear label
  - or reject with a friendly unsupported-live message
- [ ] Detect unsupported codecs before remux. v0.x supports H.264 + AAC in MPEG-TS; HEVC, AC-3, E-AC-3, AV1, and audio-only streams need explicit handling or clear errors.
- [ ] Update README support matrix so it distinguishes:
  - HLS TS H.264/AAC muxed AV
  - HLS TS with alternate audio
  - HLS fMP4/CMAF
  - live HLS
  - DRM/encrypted unsupported cases

**Ship criterion:** the extension handles common VOD HLS variants intentionally and fails unsupported variants with clear, typed errors.

---

## v1.0 - Polish, settings, disclaimer

Goal: shippable to friends - covers common HLS VOD end-to-end plus YouTube, with first-class Hotmart support.

- [ ] First-run modal in the popup with the legal disclaimer ("only download content you have the right to"); acceptance stored in `chrome.storage.local`.
- [ ] `options.html` page with:
  - Default quality (highest / 1080p / 720p / 480p / ask each time).
  - Concurrency (default 4, range 1-8).
  - Subtitle output mode placeholder (off / sidecar once v1.1 lands).
  - Filename template per-adapter (default `{section} - {lesson}.mp4` for Hotmart, `{title} - {basename}.mp4` for default) with a live preview.
  - **Per-adapter enable/disable list** with descriptions.
  - **Per-origin block list** so users can silence detection on specific sites.
  - "Reset detected videos for current tab" button.
  - "Clear all captured auth/header state" button.
  - Plain-language explanation of why `<all_urls>` permission is needed.
- [ ] Final icon set + active-state badge styling.
- [ ] Security/privacy review:
  - no full signed URLs in committed logs
  - auth headers are not persisted longer than needed
  - query-param redaction covers known CDN token names
  - no third-party network calls
- [ ] Write `CHANGELOG.md` and tag `v1.0.0`.
- [ ] Manual smoke test on 4 sites: a Hotmart course, YouTube (one progressive + one HD adaptive video), a public HLS demo, a generic third-party site with HTML5 HLS.
- [ ] Test on a fresh Chrome profile using only the unpacked `dist/` extension.
- [ ] Update `README.md` install section with the final unpacked-load steps and the support matrix from v0.12.

**Ship criterion:** the extension is usable end-to-end on Hotmart, YouTube, and at least one unrelated HLS VOD site by a non-technical user on a fresh Chrome profile.

---

## v1.1 - Subtitle support

Goal: when the manifest references subtitles, the user can download usable sidecar captions.

- [ ] Surface subtitle media playlists alongside variants for HLS. DASH subtitles can wait until the DASH milestone.
- [ ] In the popup, replace the placeholder "Include subtitles" checkbox with real language choices from the manifest.
- [ ] When enabled, fetch `.vtt`/`.webvtt` playlists and segments, concatenate them, and fix per-segment cue timestamps using cumulative `EXTINF` duration.
- [ ] Save sidecar `.vtt` files alongside the MP4 by default.
- [ ] Defer "mux into MP4 as `mov_text`" until a separate muxing-engine decision lands; mux.js does not solve text-track muxing.
- [ ] Verify: a Hotmart lesson with pt-BR subtitles downloads MP4 + VTT and the VTT loads in VLC.
- [ ] Verify on a public HLS stream with subtitles.

**Ship criterion:** subtitled HLS streams can download sidecar captions that play with the MP4.

---

## v1.2 - DASH (.mpd) support

Goal: add DASH deliberately, without assuming the HLS remux path automatically applies.

- [ ] Add `mpd-parser` as a dependency and bundle it through esbuild.
- [ ] Parse MPDs in the offscreen document and extract:
  - periods
  - adaptation sets
  - video representations
  - audio representations
  - segment URLs from `SegmentTemplate`, `SegmentList`, and initialization data
- [ ] Detect DRM upstream. If `ContentProtection` references Widevine (`edef8ba9-...`), PlayReady, or FairPlay, set `mediaEntry.drm = true` so the popup shows "DRM-protected".
- [ ] Decide the unencrypted DASH muxing strategy before implementation:
  - combine fMP4 video/audio fragments with local MP4 box tooling, or
  - introduce an ffmpeg.wasm mux engine behind an abstraction.
- [ ] Handle DASH ClearKey only if it is truly feasible without DRM/EME. Otherwise classify it as unsupported/DRM and explain that in the UI.
- [ ] Quality picker should show video representations (resolution + bitrate); audio is implicit unless multiple audio languages exist.
- [ ] Add DASH fixtures for MPD parsing and one public unencrypted end-to-end stream.
- [ ] Verify: download a public DASH-IF reference stream end-to-end and play the MP4.

**Ship criterion:** a public unencrypted DASH stream downloads to a playable MP4, or unsupported DASH variants fail with accurate DRM/unsupported messages.

---

## v1.3 - Progressive download (single MP4 / WebM)

Goal: when a site serves a single non-segmented `.mp4` or `.webm` via `<video src="...">`, the user can download it in one shot.

- [ ] In the offscreen document, branch on `kind === 'progressive'`: skip parsing, skip remux, stream the file straight to OPFS, then to `chrome.downloads.download` via a Blob URL.
- [ ] Use `Content-Length` when available for a bytes progress bar.
- [ ] Use `Content-Disposition` filename when present; otherwise fall back to the adapter's `deriveFilename`.
- [ ] Support HTTP `Range` requests for resumable / parallel-chunk progressive downloads after the simple single-request path works.
- [ ] Preserve file extension and MIME correctly (`.mp4` vs `.webm`).
- [ ] Verify: download a public sample MP4 and a public sample WebM end-to-end.

**Ship criterion:** a plain progressive MP4/WebM on any site downloads with a progress bar.

---

## v1.4 - Adapter SDK + a third real adapter

Goal: adding a new site adapter is a documented, typed, small task. Hotmart and YouTube are already in tree (v0.x); this milestone formalizes the contract and adds one more concrete adapter to prove the SDK.

- [ ] Write `docs/adapters.md` with the full TypeScript adapter contract, lifecycle, and a worked example end-to-end.
- [ ] Extend the typed adapter interface with capability hints where useful:
  - `needsFrameProxy`
  - `supportsBatch`
  - `filenameTemplateDefaults`
  - `qualityPreferenceHints`
- [ ] Pick one additional real-world target and implement it as `adapters/{name}.ts`. Suggested targets:
  - **Generic Video.js detector** - matches any page where `videojs` is on `window` and pulls metadata from the player's data attributes.
  - **Bunny CDN** or **public Vimeo embeds**.
  - **Twitch VODs** (non-live, non-DRM clips and past broadcasts).
- [ ] Document adapter boundaries in the SDK: adapters may target large platforms, but must still respect the project-wide constraints of no DRM decryption, no backend service, no telemetry, and no site-specific logic outside `extension/adapters/`.
- [ ] Add an adapter-matching dev tool: in the options page, a "Test URL" field that shows which adapter would match.
- [ ] Add adapter conformance fixtures covering: `matches`, `scrapePageMeta` on saved HTML, `deriveFilename`, and any capability hints.
- [ ] Verify: with the new adapter installed, the popup correctly tags streams from that site with the new adapter id and produces a properly named MP4.

**Ship criterion:** the project has three non-trivial typed adapters and a contributor can write a fourth by following `docs/adapters.md`.

---

## Post-v1.4 (out of scope for now, parked here)

- [ ] **Batch download** of all lessons in a section (Hotmart adapter; `plan.txt` §6 "Single-video vs batch"). Generalize to other adapters where applicable.
- [ ] **In-page Download button** injected next to the player by `page-content.js` (per-adapter opt-in).
- [ ] **Firefox port** (MV3 in Firefox lacks `offscreen` - would need a different long-lived context strategy).
- [ ] **Resume interrupted downloads** across browser restarts by persisting OPFS workspace manifests and request metadata.
- [ ] **MSE / `blob:` source streams** that build a MediaSource via `SourceBuffer.appendBuffer` - needs custom hooks beyond fetch/XHR.
- [ ] **Adapter sideloading** so users can drop a JS/TS adapter file into a folder and have it picked up without a rebuild.
- [ ] **Optional ffmpeg.wasm mux engine** for subtitle muxing, hard DASH cases, or formats mux.js/local MP4 tooling cannot cover.
- [ ] **Image / audio detection** a la Video DownloadHelper's full feature set.
- [ ] **Repo rename** from `hotmart-downloader/` to something neutral once we ship.
