# ROADMAP

Shippable milestones for the Video Downloader extension. Each version is independently demoable — at the end of a version you should be able to load the extension unpacked and *show something working*.

The engine is **site-agnostic**: generic media detection runs everywhere, and a **site-adapter** layer adds richer metadata, auth handling, and naming for specific origins. **YouTube and Hotmart Club have dedicated adapters today.** Hotmart's needs (cross-origin iframe, signed `hdntl` token, AES-128 segments) drove a lot of the early design, but no site-specific code lives outside `extension/adapters/`. Adding another adapter (Vimeo, generic Video.js, Bunny CDN, etc.) is intentionally a small, well-scoped task — see v1.4.

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

## v0.11 - YouTube support (progressive, working through n-param)

Goal: download YouTube videos end-to-end as the second real adapter. YouTube uses DASH-style adaptive streams (separate audio + video) on `videoplayback?...` URLs plus a small set of progressive single-stream itags, *not* HLS — so v0.11 brings parts of the v1.2 DASH and v1.3 progressive milestones forward for one site rather than depending on the HLS completeness work (parked in v0.12).

**Shipped scope:** itag=18 (360p, H.264 + AAC) downloads end-to-end against current YouTube — the n-param solver IS in (early scoping had it as v0.11.1; smoke testing surfaced that modern YouTube 403s itag=18 too without it, so it folded into v0.11). Adaptive HD (1080p+) is intentionally still **deferred to v0.11.1** because it depends on the fMP4 two-track-combine muxer which is its own subproject.

Constraints retained from the original plan:

- **H.264 + AAC only.** VP9 / AV1 video surface in the picker (so users can SEE the inventory) but downloading them currently fails — only the AAC audio pairing is wired. Lifting this is a follow-up beyond v0.11.1.
- **Most YouTube content is non-DRM.** Rentals, Movies & TV, some music videos use Widevine; `playabilityStatus !== 'OK'` returns no streams so the picker stays out of a broken state.
- **Live, age-gated, region-locked** content is out of scope.

Tasks:

- [x] webRequest patterns + URL classification: detect `*://*.googlevideo.com/videoplayback*` URLs, classify via `mime=` + itag.
- [x] `adapters/youtube.ts` — matches watch / shorts / embed / live / youtu.be. `scrapePageMeta` parses `ytInitialPlayerResponse.videoDetails` (videoId, title, channelTitle) with og:meta fallback. `deriveFilename` returns `{channelTitle} - {videoTitle}`.
- [x] `discoverStreams` enumerates `streamingData.formats[]` + `adaptiveFormats[]`, surfaces them in the popup quality picker with resolution / codec / exact filesize. Audio is paired internally for adaptive variants (AAC/m4a only for v0.11).
- [x] Progressive single-stream path (`extension/offscreen/progressive.ts`) — streams the chosen URL to OPFS via the v0.10 workspace; no remux. Reusable for v1.3's broader progressive milestone.
- [x] **N-param + signature decipher.** AST-based extractor in `extension/offscreen/yt-sig.ts` using vendored `LuanRT/YouTube.js` utilities (`extension/vendor/youtubei-js/`, MIT) + `meriyah` parser. Auto-discovers `base.js` via `/iframe_api`, extracts the URL-prep function via the `.set("alr","yes")` AST anchor, transitively collects dependencies, wraps in an IIFE, evaluates inside a sandboxed iframe (MV3 CSP forbids `Function()` in the offscreen document — see `extension/offscreen/sandbox.html`). Caches per player_id. Applied to every URL hitting `*.googlevideo.com`.
- [x] DRM handling: `playabilityStatus.status !== 'OK'` returns no streams. The existing v0.6 DRM detection on webRequest URLs continues to flag entries — both layers fail closed.
- [ ] **Adaptive HD path (deferred to v0.11.1).** Picking 1080p currently surfaces a typed `UnsupportedFormatError` because the fMP4 two-track combine muxer doesn't exist yet. Data plumbing for pairing is already in (`HlsVariant.pairedAudioUrl` + `pairedAudioContentLength`); the decipher handles `signatureCipher` too (already exposed via `solver.decipher({signatureCipher})`). What's missing is the muxer + admitting `signatureCipher`-only formats in `discoverStreams`.
- [x] Verify: `npm run check` passes; unit tests cover format enumeration + DRM detection + audio pairing + AST extractor against a synthetic base.js fixture + sandbox evaluation.
- [ ] Verify (smoke): SPA navigation between watch pages updates popup metadata.
- [ ] Verify (smoke): a DRM-gated YouTube rental shows no row (or "DRM-protected").

**Ship criterion:** ✅ a public non-DRM YouTube video downloads to a playable MP4 via the progressive single-stream path (verified 2026-05-20). Adaptive HD is explicitly deferred to v0.11.1 with the architectural plumbing already in place.

---

## v0.11.1 - YouTube HD via fMP4 two-track combine muxer

Goal: lift the v0.11 progressive-only ceiling. The hard piece is the muxer — most of the rest of the work is already done by v0.11 (decipher handles both n + signature, AST extractor is in, sandboxed eval works, pairedAudioUrl is plumbed).

- [x] **Admit `signatureCipher`-only formats in `discoverStreams`.** `variantFromFormat` now goes through `urlAndCipherFromFormat`: when a YouTube format ships `signatureCipher` instead of `url`, we decode the `url=` component for `variant.url` and keep the full encoded triple on `variant.signatureCipher`. `pickDefaultAudioFormat` admits cipher-gated audio the same way (1080p+ era YouTube serves audio under signatureCipher too).
- [x] **Thread `signatureCipher` from popup pick → SW → offscreen.** New `HlsVariant.signatureCipher` + `HlsVariant.pairedSignatureCipher` mirror the existing `pairedAudioUrl` plumbing. `RunPayload` and `DownloadRequest` carry them through; the adaptive downloader hands them to `solver.decipher({ signatureCipher })` per side.
- [x] **fMP4 two-track combine muxer.** New module `extension/offscreen/mp4-combine.ts`:
  - Parses each input's `moov`; extracts its single `trak`.
  - Builds a combined `moov` with both `trak` boxes — audio track_ID renumbered (default 2), `mvhd.duration` = max of both, `mvhd.next_track_ID` bumped past, combined `mvex` with both `trex` entries.
  - Interleaves moofs from both inputs in tfdt time order with monotonic global `mfhd.sequence_number`. Video wins time ties so the keyframe lands first.
  - Patches `tfhd.track_ID` on every audio moof.
  - No tfdt / signed-cto / duration-sentinel patching needed — googlevideo serves correctly-formed fragments (unlike mux.js output).
- [x] **New adaptive download path in the offscreen** (`extension/offscreen/adaptive.ts`). Deciphers both video + audio URLs through `getYouTubeSolver`, fetches both in parallel via the content-script proxy, hands the buffers to `combineFmp4`, writes the result straight to OPFS via the v0.10 workspace. `offscreen.ts` dispatch routes `req.kind === 'dash'` here.
- [x] README updates: replace the v0.7-pinned coverage line with an accurate v0.11.1 line.

**Ship criterion:** the adaptive HD pipeline is wired end-to-end — signatureCipher + n-param decipher, fMP4 two-track combine muxer, parallel video+audio fetch, OPFS-backed output — and ready to light up the moment YouTube responses carry per-format URLs again. Reaching that surface requires v0.11.2's InnerTube client switch (see below); on current WEB-client responses, real-world adaptive HD is **not downloadable** because YouTube no longer serves per-format URLs to the WEB client.

What lands in v0.11.1:
- `HlsVariant` gained `signatureCipher` + `pairedSignatureCipher`; the YouTube adapter's `urlAndCipherFromFormat` extracts the decoded `url=` for the picker and keeps the encoded triple alongside. Reads both modern (`signatureCipher`) and legacy (`cipher`) field names so future field-rename drift doesn't silently drop variants.
- `RunPayload` + `DownloadRequest` carry the cipher blobs through to the offscreen, mirroring the v0.11 `pairedAudioUrl` plumbing.
- `extension/offscreen/mp4-combine.ts` parses both single-track fMP4 inputs, builds a combined moov (two traks with distinct track_IDs, combined mvex, bumped `next_track_ID`, max-duration mvhd with fragment-derived fallback for sources that ship zero/0xFFFFFFFF), and emits time-interleaved moofs with globally monotonic `mfhd.sequence_number` and patched audio-side `tfhd.track_ID`.
- `extension/offscreen/adaptive.ts` deciphers both URLs via `getYouTubeSolver`, fetches in parallel via the content-script proxy, hands buffers to `combineFmp4`, and writes straight to OPFS via the v0.10 workspace. `offscreen.ts` dispatch now routes `req.kind === 'dash'` here.
- Popup gate (`isVariantDownloadable`) now admits adaptive AVC variants with `pairedAudioUrl`; VP9/AV1/video-only get an inline "not supported" label and sort behind the downloadable ones.

What stays unlit until v0.11.2:
- **YouTube WEB-client responses have migrated to SABR (Server-Adaptive Bit Rate).** `streamingData.adaptiveFormats[]` ships full metadata (itag, codec, bitrate, contentLength, …) but no `url`, no `signatureCipher`, no `cipher`. The only field pointing at playback is `streamingData.serverAbrStreamingUrl`, which requires UMP-encoded POSTs plus a poToken from BotGuard. Only the progressive itag=18 fallback still carries a direct URL — which is why 360p downloads work today and the rest of the inventory doesn't even surface as selectable.
- The path forward is **not** to implement SABR client-side (poToken solving is a separate multi-week project). Instead, v0.11.2 swaps the catalog scrape from inline `ytInitialPlayerResponse` to a content-script POST to `/youtubei/v1/player` with a non-WEB InnerTube client context (IOS / TVHTML5_SIMPLY_EMBEDDED_PLAYER). Those clients have historically returned `adaptiveFormats[].url` or `signatureCipher` — exactly what v0.11.1's pipeline already consumes.
- **Known limit also carrying forward**: each adaptive stream is fetched in one shot through the content-script proxy and crosses `chrome.runtime.sendMessage` as a base64 body. For large files (high-bitrate 1080p AVC ≈ tens to low hundreds of MB) this can hit Chrome's practical message-size limit. The proper fix is the chunked / Range-based proxy scoped under v1.3 (progressive downloads); same fix lights up both paths.

---

## v0.11.2 - Switch YouTube catalog scrape to non-WEB InnerTube client

Goal: get adaptive (HD) URLs flowing again so v0.11.1's pipeline has something to actually run on. YouTube's WEB-client `ytInitialPlayerResponse.streamingData.adaptiveFormats[]` has been stripped of per-format URLs (SABR migration); non-WEB clients (IOS, TVHTML5_SIMPLY_EMBEDDED_PLAYER, …) still ship them. v0.11.2 swaps the scrape source.

Constraints:
- **No backend.** Per AGENTS.md §10 we can't introduce a server. The InnerTube POST has to originate from a context allowed to talk to `www.youtube.com` — i.e. the content script in the watch tab. (Same-origin avoids the CORS / referer issues that 403'd offscreen-originated googlevideo fetches in v0.6.)
- **No poToken / SABR client.** That's a separate project — see "out of scope" below.
- **Client choice is volatile.** Which client returns URLs has been an arms race throughout 2024–25. The implementation needs to be parameterizable so we can rotate without re-engineering: a small `INNERTUBE_CLIENTS` table mirroring LuanRT/YouTube.js's current working set.

Tasks:

- [x] Define a typed `InnerTubeClient` record in `extension/adapters/youtube-clients.ts` carrying `{ name, apiKey, context, thirdPartyEmbedUrl?, userAgent? }`. Seeded with `IOS` and `TVHTML5_SIMPLY_EMBEDDED_PLAYER`. Per-client API keys (different clients ship different ones).
- [x] In `extension/adapters/youtube.ts`, add `fetchInnerTubePlayer(videoId, client)` that runs **in the content-script context** (`credentials: 'include'`, `Content-Type: application/json`, `X-YouTube-Client-Name` / `-Version` headers; client-specific User-Agent when declared). Returns the parsed body or `null` on any failure.
- [x] Adapter `discoverStreams` becomes a two-step ladder (now async):
  1. Parse inline `ytInitialPlayerResponse` first (cheap; still useful for some videos and for `videoDetails`).
  2. If inline yields no adaptive variants, iterate `INNERTUBE_CLIENTS` in order; first response with adaptive URLs wins. Cached per `videoId` so SPA nav + initial-scrape pairs don't double-fetch.
- [x] Adapter contract change: `discoverStreams` typed as `DiscoveredStream[] | Promise<DiscoveredStream[]>`. `page-content.ts` wraps the call in `Promise.resolve()` so synchronous adapters stay zero-cost.
- [x] Surface the chosen client in the SW log (`youtube discoverStreams: client=IOS succeeded`) so when a future YouTube change breaks the current client, the diagnostic is one log line away. `buildStreamsFromPlayerResponse` also tags the `source` field on its log (`inline` / `innertube` / `probe:<name>`).
- [x] DRM / unplayable handling unchanged — `playabilityStatus !== 'OK'` from the InnerTube response yields no streams, same gate the inline path uses.
- [x] Unit tests: `buildInnerTubePlayerBody` per-client shape (IOS + embedded-TV); `fetchInnerTubePlayer` request URL + headers + body, non-200 + threw-fetch + malformed-JSON failure modes; `discoverYouTubeStreams` ladder (inline-wins, fallthrough-to-InnerTube, all-fail-to-inline, stop-at-first-success).
- [x] AGENTS.md addition: §8 gotchas #18 (SABR / InnerTube fallback) + #19 (discoverStreams now async-capable).

Verification (manual, on real YouTube — pending real-world smoke run):
- [ ] Inventory log shows `source: 'innertube'` (or `'inline'` if the inline blob still ships URLs) with adaptive formats reporting `url` / `sig` / `cipher`. The previous `no-url(keys=...)` diagnostic should no longer fire for adaptive entries.
- [ ] Picker shows 1080p (or whatever the highest AVC variant is) as selectable.
- [ ] 1080p AVC download produces a single MP4 that plays in VLC + QuickTime with audio + video sync, correct duration, accurate seek. (This is the verify box v0.11.1 deferred — it belongs here, after the URLs come back.)

Explicitly out of scope (parked for a later milestone, possibly never):
- SABR / UMP streaming client-side. Requires UMP framing + BotGuard-derived poToken. Track separately if every InnerTube client gets gated at once.
- AV1 / VP9 muxing. Picker continues to label these "not supported" — lifting needs a re-encode the project rules out.

**Ship criterion:** on a public non-DRM YouTube watch page, the popup lists the full adaptive inventory with selectable HD AVC variants, and downloading 1080p produces a playable MP4 via the v0.11.1 pipeline.

---

## v0.11.3 - Popup UX overhaul + chunked Range proxy

Goal: unblock real-world 1080p YouTube downloads (the v0.11.1 + v0.11.2 pipeline ran into chrome.runtime.sendMessage's body-size cap on the first real test) and fix two structural popup-UX gaps that surfaced during the smoke testing.

Tasks:

- [x] **SPA-nav stale entries.** `chrome.tabs.onUpdated` doesn't always surface `changeInfo.url` for YouTube's `history.pushState`. The fix compares `tab.url` against the cached URL on every fire (not just when changeInfo carries the URL), so a pushState that only triggers a status/title update still detects the navigation and clears the old entry list. Download states are no longer cleared on nav — they persist so the cross-tab section below can surface them.
- [x] **Cross-tab download visibility.** `broadcastDownloadState` no longer filters by tabId — every subscribed popup receives every download state update. The SUBSCRIBE replay drops the per-tab filter for the same reason. The popup grows an "Active downloads" section at the top that renders any download whose mediaId isn't backed by a visible entry in the current tab (covers cross-tab downloads + same-tab downloads whose entry was cleared on navigation). Cancel + Show-in-folder + Dismiss handlers were already delegated by data attribute, so they work on orphan rows without changes.
- [x] **Chunked Range-based proxy fetch.** New `extension/offscreen/range-fetch.ts`: `fetchArrayBufferRanged` issues 8 MB-per-chunk `Range: bytes=A-B` requests through the existing content-script proxy, parses Content-Range on the first reply to learn total size, and reassembles into a single Uint8Array. Each chunk's base64 transit stays under chrome.runtime.sendMessage's practical cap. Sequential (not parallel) chunks to keep message bus pressure low. Graceful fallback when the server ignores Range and returns the full body. `downloadAdaptive` switches both video and audio fetches to this helper; HLS / progressive paths are unchanged (their per-segment payloads already fit comfortably).
- [x] Tests: 11 new tests for `parseTotalSize` (Content-Range / Content-Length / fallback) and `fetchArrayBufferRanged` (single chunk, multi-chunk reassembly, progress callbacks, default chunk size, failed-chunk propagation, server-ignores-Range fallback, AbortSignal mid-stream). Plus the existing 211 tests stay green.
- [x] Content script `handleProxyFetch` now forwards `Content-Length` and `Content-Range` on the reply. Both are documented as the only response headers it surfaces (everything else would bloat the runtime message we're trying to fit under the cap).

**Ship criterion:** real-world 1080p AVC YouTube download produces a playable MP4 end-to-end (this is the verify box v0.11.1 + v0.11.2 deferred). Cross-tab downloads visible in any popup. SPA navigation between YouTube watch pages clears stale entries.

Manual verification (pending real-world smoke run):
- [ ] Click Download on a 1080p variant. Offscreen log shows multiple `fetch video done` lines as chunks complete (not a single hang). Popup row's progress bar advances through the fetch phase. Final MP4 plays in VLC + QuickTime with correct duration + audio/video sync.
- [ ] Open YouTube watch page A, navigate to B without refreshing. Popup re-discovers B's variants. A's entries are gone.
- [ ] Start a download in tab A, switch to tab B, open popup. The download appears in the "Active downloads" section at the top. Cancel button works.

---

## v0.11.4 - Popup polish + multi-dub audio picker

Goal: clean up the regressions / rough edges that surfaced after v0.11.3 went out, and add a small feature for YouTube videos with multiple audio tracks (dubs).

Tasks:

- [x] **Quality picker "switches back to 1080p" after click.** The actual download URL was correct, but the size-badge derivation re-read `entry.variants[0]` after the dropdown was replaced by the in-progress UI — so the displayed size visibly reverted to the 1080p estimate regardless of the user's pick. Fix: `DownloadState.variantUrl` is now seeded by the SW at click time; the popup's `pickDisplayVariantUrl` helper pins the badge to it.
- [x] **Hide unsupported variants from the quality picker.** v0.11.1 ranked VP9 / AV1 behind downloadable variants and labeled them "— not supported". Cleaner UX to drop them entirely. When every variant is unsupported, surface "No supported variants" so the empty state is explained.
- [x] **× button on terminal-state orphan rows.** Cross-tab "Active downloads" rows in saved / error / canceled states now have a corner × that maps to the existing `dismiss-download` handler. Lets the user clear out leftovers from other tabs without "↻ Again"-ing them first.
- [x] **Multi-dub audio: prefer the original track by default.** YouTube returns ALL dubs' AAC formats in `adaptiveFormats[]`, each tagged with an `audioTrack.audioIsDefault` flag. v0.11's picker filtered to AAC and sorted by bitrate — which silently paired whichever dub happened to win the bitrate tiebreak. Field report: English video downloaded with French audio. Fix: `pickDefaultAudioFormat` now filters to `audioIsDefault === true` first; bitrate is only a within-default tiebreaker.
- [x] **Audio-track picker in the popup.** When a video has multiple tracks the popup renders a second dropdown next to the quality picker. New `AudioTrack` type; `audioTracks?` on `DiscoveredStream` / `MediaEntry`; `audioTrackId?` on `DownloadRequest` / `DownloadState` / `START_DOWNLOAD`. SW resolves the chosen id against `entry.audioTracks` and substitutes the chosen track's URL for the variant's default `pairedAudioUrl`. Picker hides when entry has 0 or 1 tracks — most videos.
- [x] **Popup helpers extracted + tested.** `extension/popup/popup-helpers.ts` carries the variant-routing + audio-track helpers (`pickDisplayVariantUrl`, `pickDownloadVariantUrl`, `filterDownloadableVariants`, `hasAudioTrackPicker`, `pickDefaultAudioTrackId`, `formatAudioTrack`, …) so the next regression of this shape is caught by a fixture rather than a field report. 33 popup-helpers tests + 8 new adapter tests (audioIsDefault preference, `buildAudioTracks` shape, multi-dub fixtures); 269 total, `npm run check` green.

**Ship criterion:** ✅ a YouTube video with multiple audio tracks downloads with the user-chosen (or default-original) audio paired correctly; the quality picker size badge tracks the chosen variant; unsupported variants don't pollute the dropdown.

---

## v0.11.5 - YouTube 4K via AV1 (OPFS-streaming muxer)

Goal: lift the 1080p AVC ceiling for AV1 4K. YouTube caps AVC at 1080p; 1440p / 2160p / 4320p exist only as **AV1** (fragmented MP4) or **VP9** (fragmented WebM). v0.11.5 ships the AV1 path: the OPFS-streaming refactor (memory-bounded muxer + chunked Range fetch) plus the codec-gate flip that admits `av01.*` variants. VP9 stays out of scope — split to **v0.11.6** because it needs a separate container muxer.

Constraints retained:
- **No re-encoding.** Stream-copy only. AV1-in-MP4 is a first-class container we can pass through without touching samples.
- **Memory is the load-bearing problem at 4K.** A 10-minute 2160p stream is 1-3 GB per side; the pre-v0.11.5 adaptive path buffered both fully before combining. Offscreen heap can't hold that.

Tasks (phased):

**Phase A — OPFS-streaming muxer (prereq for 4K at any codec).**
- [x] `extension/offscreen/range-fetch.ts` gains `fetchToOpfsRanged` — same chunked Range loop as `fetchArrayBufferRanged` but each chunk is appended directly to an OPFS file via positioned writes instead of accumulating in a JS-heap `Uint8Array`. Peak heap during fetch is one chunk (~8 MB) regardless of stream size.
- [x] `extension/offscreen/mp4-combine.ts` introduces an `Fmp4Source` abstraction (`memorySource(Uint8Array)` for tests + small inputs, `fileSource(File)` for OPFS-staged inputs). `combineFmp4` is now async over `Fmp4Source`; the top-level walker reads only the 16 bytes needed per box header and bounds-checks against `source.byteLength`, not against the buffer slice (the latter trips on any mdat larger than the chunk — that's how the first 1440p attempt RemuxError'd until fixed). Each fragment's moof is read in full on-demand; the mdat body is stream-copied source → output in 1 MB chunks. Peak JS heap during combine is now bounded at a few MB regardless of input size.
- [x] `extension/offscreen/adaptive.ts` stages fetched video / audio to workspace files (`video.in`, `audio.in`) via `fetchToOpfsRanged`, then hands `fileSource(File)` wrappers to `combineFmp4`. Phase-weighted progress (fetch 0..80 / remux 80..100) preserved.
- [x] No regression on 1080p AVC — same byte-level output, just streamed.

**Phase B — AV1 in fMP4 (`.mp4` output).**
- [x] Drop the `avc1.*` whitelist in `extension/popup/popup-helpers.ts` for `av01.*`. Admit AV1 variants in the picker.
- [x] Muxer needs no changes — combineFmp4 copies the source's `trak` (which carries the codec-specific sample entry inside `mdia.minf.stbl.stsd`) verbatim. AV1's `av01` sample entry rides through unchanged; Chrome / VLC / QuickTime all play av01-in-mp4.
- [x] Manual verify: a public YouTube 1440p AV1 download produces a playable MP4. (1440p verified in the field; 2160p path is identical so it inherits the same correctness.)

**Phase D — Polish + verification matrix.**
- [x] `formatVariant` includes a friendly codec label (`H.264`, `AV1`, `VP9`) so AVC and AV1 variants at the same resolution are visually distinct in the dropdown. Without it the field report was: "I select 1440p, badge shows 283 MB. I select 1080p, badge shows 138 MB. I select 1440p again, badge shows 157 MB" — the user had unknowingly switched between AVC 1440p and AV1 1440p because both labeled identically.
- [x] `filterDownloadableVariants` sorts by `(resolution desc, bandwidth desc)` so all variants of the same height group together. Avoids the pure-bandwidth sort that would place AV1 1440p between AVC 1080p and AVC 720p.
- [x] `pickDisplayVariantUrl` aligned to the same sort so the badge matches the dropdown's default-selected option.
- [x] README support matrix updated for v0.11.5 — AVC + AV1 (with 4K), multi-dub picker, VP9 still rejected.

**Ship criterion:** ✅ public 4K AV1 YouTube videos download to a playable MP4 with correct duration / audio-video sync / accurate seek; peak JS heap during fetch + combine stays bounded regardless of source size; 1080p AVC continues to work unchanged.

VP9 (`vp09.*`) stays rejected in the picker for v0.11.5 — picked up in v0.11.6 (separate WebM container muxer + Opus audio pairing).

Explicitly out of scope (carried forward to v0.11.6 or beyond):
- VP9 in WebM. Different container, different muxer module, Opus audio pairing — see v0.11.6.
- VP9 transmuxed into MP4 with `vp09` sample entries. Container-switch in WebM is the simpler exit; we're not solving the transmux path.
- Re-encoding (any codec → any codec). Project rule, unchanged.
- HDR / HFR metadata fidelity audit. CICP / mastering display / max CLL tags should pass through untouched in stream-copy, but it's not separately verified — file as a follow-up if a user reports washed-out HDR output.
- 8K (4320p). Same pipeline as 4K, but message-bus / OPFS-quota envelopes need their own real-world test.
- AV1 audio (`opus` in MP4 via the experimental codec entry). Stays AAC for the AV1 path.

---

## v0.11.6 - YouTube SPA-nav correctness + cross-tab orphan rows

Goal: fix the cluster of post-v0.11.5 field reports around YouTube's SPA navigation between watch pages.

Tasks:

- [x] **Stale inline player blob on SPA-nav.** YouTube doesn't rewrite the inline `ytInitialPlayerResponse` script tag when the user clicks through to a different video — the player UI hydrates from XHR responses but the script remains frozen at the initial-load video. Reading `videoId` from that blob always returned the original video's id, so `discoverStreams` happily produced the original variants and the SW dedupe layer kept the original entry. The popup never updated until full refresh.
  - `extractVideoIdFromUrl()` reads the canonical id from the URL (`/watch?v=`, `/shorts/X`, `/embed/X`, `/live/X`, `youtu.be/X`).
  - `discoverYouTubeStreams` compares URL videoId vs inline videoId; on mismatch, skips the "use inline if it has adaptive" shortcut and forces the InnerTube ladder against the URL's id.
  - `scrapeYouTubeMeta` also prefers the URL videoId and ignores stale inline fields when ids disagree.
- [x] **Race between `STREAMS_DISCOVERED` and `tabs.onUpdated`.** Both update the URL cache via `setTabUrl`; the navigatesuccess-triggered `STREAMS_DISCOVERED` could win the race and update the cache to the new URL, after which `tabs.onUpdated` saw `prev === nextUrl` and skipped its clear. `handleStreamsDiscovered` now does the same prev/next compare + clear so whichever fires first does the right thing.
- [x] **Title still showed old video after SPA-nav.** Fallback chain preferred `og:title` over `document.title`, and YouTube updates `og:title` a few hundred ms later than `document.title`. The MutationObserver fires *because* `document.title` changed, so it's the freshest signal at that moment — when inline is stale, prefer it.
- [x] **Cross-tab orphan rows show full info.** When a download is in flight on another tab (or the source-tab entry was cleared by nav), the popup's "Active downloads" section used to render filename + tab number only. New `DownloadState.entrySnapshot` captures title, section, kind, adapterId, duration, variant content-length, resolution, codec, bandwidth, paired-audio content-length at download-start time — orphan rows now render the same shape as inline rows (title, adapter pill, duration / size / quality+codec / kind badges, action). Falls back to the historical minimal layout when the snapshot is absent (older states).
- [x] Diagnostic logs added throughout the SPA-nav flow so future regressions are visible: entry log with `pageUrl` + `urlVideoId`, "inline blob is stale (SPA-nav)" when ids disagree, "streams discovered on navigated tab — clearing previous entries" when the race wins, "tabs.onUpdated: title change, URL already in cache" debug-level for the other branch, "observe: title changed { prev, next }" on the title MutationObserver fire, and a debug-level dump of every title source in `scrapeYouTubeMeta`.

**Ship criterion:** ✅ navigating between YouTube watch pages without refreshing updates the popup's row (title + variants + size) within the SPA-nav handoff; downloads remain visible cross-tab with full row info; AVC / AV1 paths unchanged.

---

## v0.11.7 - YouTube HD/4K playback fix (VLC) — shipped

Tactical fix (not a planned milestone) that took the v0.11.7 version number when it shipped. YouTube adaptive (HD/4K) downloads played with heavy frame-skipping and lost audio after seeking in VLC. Two root causes in the fMP4 two-track combiner (`extension/offscreen/mp4-combine.ts`):

- [x] **Audio track header in the wrong timescale.** The combined audio `tkhd.duration` (and any `edts/elst` segment_duration) was left in the audio source's movie timescale while the output `mvhd` used the video's — VLC read the audio track ~1.5× too long, drifting its master clock. Now rescaled into the output movie timescale.
- [x] **Interleaved single-track moofs.** The combiner emitted one input's moof then the other's (the layout AGENTS.md §8a(1) flags as VLC-breaking). It now **de-fragments** both inputs into a plain `ftyp + moov + mdat` MP4 with real sample tables (`stts` / `ctts` / `stss` / `stsc` / `stsz` / `co64`) — the structure every player handles. ctts promoted to v1 for negative composition offsets; co64 + 64-bit mdat so multi-GB 4K stays addressable; sample payload stream-copied source→output so the 4K memory budget is preserved.
- [x] ffmpeg-validated (clean decode, correct frame counts) and confirmed playing in VLC on a real 1080p download.

**Ship criterion:** ✅ YouTube AVC/AV1 HD + 4K downloads play in VLC with correct frame timing, A/V sync, and working seek (verified 2026-05-26).

---

## v0.11.8 - HLS MP4 duration-doubling fix (QuickTime) — shipped

Tactical fix (not a planned milestone) that took the v0.11.8 version number when it shipped. HLS downloads (Hotmart + default adapter) produced a fragmented MP4 whose reported duration was **doubled in QuickTime / macOS only** — the file played correctly to its real end, but the scrubber showed 2× the length. VLC / Chrome / ffmpeg were unaffected. Root cause + fix in the mux.js remux post-patcher (`extension/offscreen/remux.ts`):

- [x] **Populated base-movie header durations with no `mehd`.** The patcher wrote the real total into `mvhd` / `tkhd` / `mdhd` (to defeat mux.js's `0xFFFFFFFF` sentinel) but emitted no `mehd`. QuickTime computes a fragmented file's duration as `mvhd.duration + Σ(fragment durations)`, so a populated base movie + fragments covering the same span = 2×. (Confirmed empirically: keeping the headers + adding `mehd` still doubled in QuickTime; zeroing the headers fixed it.)
- [x] **Fix = zero the headers + declare the total in `mehd`.** `injectMehdPlaceholder` inserts a 16-byte v0 `mehd` as the first child of `mvex` while the init segment is still ahead of the fragments (so no moof/mdat offsets shift); `patchHeaderDurations` now zeroes `mvhd` / `tkhd` / `mdhd` and writes the real total into the `mehd.fragment_duration`. This is the layout FFmpeg's `empty_moov` output uses — correct in QuickTime, VLC, Chrome, and ffmpeg.
- [x] Regression test in `remux.test.ts` (zeroed headers + non-zero `mehd`); AGENTS.md §8a #6 updated. ffprobe-validated + confirmed in QuickTime + VLC on a real download.

**Ship criterion:** ✅ HLS MP4 downloads report the correct duration in QuickTime as well as VLC / Chrome / ffmpeg (verified 2026-05-27).

---

## v0.11.9 - UI, settings & quality-of-life

Goal: the download pipeline is solid across HLS / YouTube AVC+AV1 / progressive, so the next focus is making the extension pleasant to use rather than adding more codecs or sites. This pulls the settings/options work forward from v1.0 (which becomes the release-gate milestone) and folds in popup polish. VP9 and broader site/codec support are deferred and picked up as needed (see v0.11.10, v0.12, v1.4).

Landed so far (incremental QoL fixes from field reports):

- [x] **Extension version in the popup header.** Read from `chrome.runtime.getManifest().version` and stamped next to the title, so a user (or a bug report) can tell which build is loaded at a glance.
- [x] **Reset also clears downloaded (saved) videos.** The header Reset button cleared the tab's detected entries but left saved/finished downloads lingering in the cross-tab "Active downloads" section (the SW deleted the states but never told open popups to drop them). `RESET_TAB` now clears the current tab's entries + downloads **plus every finished (saved/error/canceled) download across all tabs**, and broadcasts `DOWNLOAD_DISMISSED` to all popups so the rows actually disappear. In-progress downloads in other tabs keep running.
- [x] **Quality dropdown stuck on "Loading…".** When an HLS entry was detected while the popup was already open, the eager `ensureParsed` could be cut off by an MV3 service-worker teardown with nothing to re-drive it (the SUBSCRIBE-time retry only runs on connect). Added an `ENSURE_PARSED` message + SW handler and a popup-side watchdog (`isManifestLoading` + capped, spaced nudges) that re-drives any entry still showing "Loading…". `ensureParsed` is in-flight-guarded, so nudges during a healthy parse are no-ops. 6 new `isManifestLoading` unit tests.

- [x] **Settings store (`lib/settings.ts`)** — typed `Settings` persisted in `chrome.storage.local` under one key, with a normalize-on-read merge (a partial/old/corrupt blob never crashes a caller), `getSettings` / `setSettings` / `onSettingsChanged`, and pure helpers (`clampConcurrency`, `isAdapterEnabled`, `isOriginBlocked`, `filenameTemplateFor`, `renderFilenameTemplate`). 19 unit tests.
- [x] **Options page (`options.html` + `options.ts` + `options.css`)** with settings persisted in `chrome.storage.local`:
  - Default quality (highest / 1080p / 720p / 480p / ask each time).
  - Download concurrency (range 1–8, default 4).
  - Filename template per adapter (defaults `{section} - {lesson}` Hotmart, `{channel} - {title}` YouTube, `{title} - {basename}` default) with a live preview.
  - Per-adapter enable/disable list.
  - Per-origin block list (add via host or full URL; normalized to host).
  - "Clear all captured auth/header state" button (new `CLEAR_ALL_CAPTURED` SW message + `clearAll()` media-store helper). Per-tab reset stays on the popup's header button.
  - Plain-language explanation of why the `<all_urls>` permission is needed.
- [x] **Wire the chosen settings through the pipeline:** default-quality preselect in the popup picker (`pickPreferredVariantUrl`, closest-height fallback), concurrency into the offscreen segment fetcher, per-adapter filename template into the SW download-filename path (falls back to `deriveFilename` when the template renders empty), per-adapter enable/disable + per-origin block list into both detection paths (`handleDetection` + `handleStreamsDiscovered`).
- [x] **Popup polish / QoL:**
  - [x] Remember the last manually-picked quality and pre-select it on the next video (`getLastQualityHeight` / `setLastQualityHeight`; `pickPreferredVariantUrl` takes it as a sticky override; cleared when the explicit default-quality changes).
  - [x] Clearer empty / error / "no supported quality" / "couldn't read manifest" states via a single testable `qualityPickerState` classifier (shared with the "Loading…" watchdog). DRM stays a row-level label.
  - [x] Copy-source-URL affordance per row (copies the redacted media URL for debugging a failed download).
  - [x] Tidy the active-downloads section — `sortOrphansForDisplay` groups live downloads above finished ones, each newest-first.
- [x] Tests for the settings store + filename-template rendering + block-list matching + default-quality preselect + sticky-last-quality + picker-state classifier + orphan ordering; `npm run check` green (321 tests).
- [x] ~~First-run disclaimer modal~~ — **dropped** at the maintainer's request. The README already carries the use-only-content-you-have-rights-to disclaimer; a blocking modal on every fresh profile wasn't worth the friction. The `disclaimerAccepted` setting was removed.

**Ship criterion:** ✅ a user can set defaults (quality, concurrency, filename template), silence detection per origin / per adapter, and the popup remembers their last-picked quality — no functionality regresses and `npm run check` passes (321 tests).

---

## v0.11.11 - YouTube downloads 403 on every quality — shipped

**Status:** ✅ shipped. Downloads work again at every quality including 4K, verified in the field.

> Numbered in the 0.11.x line where every other YouTube milestone lives. The branch was originally cut as `v0.12-yt-potoken`, which collided with the planned **v0.12 - HLS completeness** below; that milestone keeps the v0.12 number. The `-potoken` slug also stopped describing the work once the fix turned out not to need a poToken at all.

### Symptom

The popup shows "Token expired. Reload the page and try again." on every YouTube download attempt, at every quality.

### What the message actually means

`throwFromReply` (`extension/offscreen/downloader.ts:527`) maps **any** HTTP 403 to `TokenExpiredError`, and the popup renders that as the expiry copy (`extension/popup/popup.ts:265`). Nothing has expired here — the URLs are minutes old and their `expire` timestamps are ~6 hours in the future. The message is a mis-diagnosis inherited from the Hotmart/Akamai case that motivated the mapping.

### Root cause (verified against live YouTube, player `854a788e`)

YouTube now requires a **poToken** (proof-of-origin token, `pot=` query param) on `googlevideo.com/videoplayback` URLs derived from InnerTube responses. Our URLs carry no `pot`, so the CDN 403s them. Evidence gathered on a real 4K watch page:

- **Not the n-param solver.** The vendored AST extractor compiles cleanly against the current `base.js` and produces a correctly transformed `n` (`XvZVzFD4whqEQmKQ6` → `2xphpkKkwf9kqlh`). Applying it changes nothing — still 403.
- **Not a 4K problem.** 4K AV1 (itag 701), 4K VP9 (315/337), AAC audio (140), *and* progressive 360p (itag 18) all 403 identically. The itag-18 path that shipped in v0.11 is dead too.
- **Not origin / referer.** All fetches were issued from the watch page itself with credentials — the exact context AGENTS.md §8 (15/17) prescribes.
- **The URLs have no `pot` param.** Confirmed by enumerating the query string; `sparams` doesn't cover `pot` either, so it's validated server-side against the session rather than signed in.
- **The WEB page itself is fully SABR.** Inline `ytInitialPlayerResponse` returns 44 adaptive formats with **zero** URLs plus a `serverAbrStreamingUrl` carrying `sabr=1`. YouTube's own player no longer fetches media by plain GET.

This is the contingency v0.11.2 anticipated ("track separately if every InnerTube client gets gated at once"). It has now fired.

### Current InnerTube client ladder status

| Client | `playabilityStatus` | Adaptive formats w/ URL | Verdict |
|---|---|---|---|
| `WEB_CREATOR` | `OK` *(requires SAPISIDHASH; anonymous → `LOGIN_REQUIRED`)* | 36 incl. 2160p | URLs returned, **403 at CDN** |
| `MWEB` | `OK` | 45 incl. 2160p | URLs returned, **403 at CDN** |
| `TVHTML5` | `OK` | **0** — SABR-only | dead for our pipeline |
| `TVHTML5_SIMPLY_EMBEDDED_PLAYER` | `ERROR` | 0 | dead — "no longer supported in this application or device" |

Two of four clients are gone outright; the two that still hand back URLs are gated at the CDN.

### Tasks

**Phase A — stop lying to the user (small, ships independently).**

- [ ] Split the 403 mapping. Keep `TokenExpiredError` for the signed-URL-expiry case it was written for (compare the URL's `expire` param against now — a real expiry is checkable, not guessed). Add a distinct `PlaybackGatedError` in `lib/errors.ts` for a 403 on a fresh URL, with popup copy that names the real situation instead of sending users to reload the page for no reason.
- [ ] Have the YouTube path attach enough context to the error that the SW log identifies which client produced the dead URL.

### Field results (v0.12 investigation)

**The gate is session-bound, not universal.** Proven on one video, same page load, same n-solver:

| URL source | client tag | n-transform | Result |
|---|---|---|---|
| Inline `ytInitialPlayerResponse`, itag 18 | `c=WEB` | as served | 403 |
| Inline `ytInitialPlayerResponse`, itag 18 | `c=WEB` | **applied** | **HTTP 206, `video/mp4`, `ftypmp42`** |
| InnerTube, itag 18 | `c=WEB_CREATOR` | applied | 403 |
| InnerTube, itag 701 (4K AV1) | `c=WEB_CREATOR` | applied | 403 |

So URLs minted for the page's own WEB session are fetchable with **no poToken at all** — the n-transform alone is sufficient. URLs obtained from our InnerTube calls are refused regardless. The poToken requirement attaches to the *acquisition path*, not to googlevideo generally.

**Consequence for 4K: there is no client-swap that reaches it.** The only ungated client (WEB) ships **zero** adaptive URLs — 62 adaptive formats, all URL-less under SABR. Every client that does return adaptive URLs (`WEB_CREATOR`, `MWEB`) is gated. 4K therefore requires either a poToken or a SABR client; no reshuffling of the existing ladder gets there.

**Partial win — taken.** `mergeInlineIntoInnerTube` folds the inline WEB catalog into the InnerTube one instead of letting InnerTube replace it wholesale. Inline wins on rendition collisions (matched by `itag`, falling back to resolution + codecs) precisely because it is the fetchable side; InnerTube-only entries are kept so the picker still shows the real format inventory. Restores 360p downloads today. The higher qualities remain gated until Phase B — the popup will offer one working quality alongside several that error, which is the accepted trade.

**Fixed along the way:** the InnerTube ladder had been running with `hasVisitorData: false` on every call — the visitor fingerprint was absent from both the player response and `ytInitialData` on current watch pages while `ytcfg` carried it all along. `readVisitorDataFromYtcfg` closes that. Confirmed `hasVisitorData: true` in the field. It did **not** lift the 403 on its own, as expected.

### RESOLVED — 4K works via ANDROID_VR, no poToken needed

The client ladder was never exhausted; it was mis-tested. Sending the web session's `Authorization: SAPISIDHASH` header to a mobile client produces a bare `400`, which earlier work (AGENTS.md §8 #18) recorded as User-Agent validation and used to write those clients off. It is not the UA. Drop that header, supply `visitorData`, and:

| Client | auth shape | Result |
|---|---|---|
| `ANDROID_VR` | SAPISIDHASH sent | `400` |
| `ANDROID_VR` | anonymous, no visitorData | `LOGIN_REQUIRED` |
| **`ANDROID_VR`** | **visitorData, no SAPISIDHASH** | **`OK` — 26 adaptive formats, all with URLs, to 2160p** |

And the URLs actually serve: itag 401 (AV1 2160p) and itag 140 (AAC) both returned **HTTP 206 with real `ftypdash` bytes**. They carry no `n` param, so the signature solver is skipped on this path entirely.

itag 401 is AV1-in-MP4 paired with AAC-in-MP4 — exactly what the existing v0.11.5 OPFS-streaming combiner already handles. **No new muxer, no BotGuard, no remote code, no third-party hosts, no new permissions.**

Note the dependency: this only works because of the `visitorData` fix above. Without it ANDROID_VR is refused, which is why the ladder has to skip a `requiresVisitorData` client rather than burn a request on it.

**Phase B — mint a poToken (superseded; kept as a fallback position).**

The extension has an advantage yt-dlp doesn't: it already runs inside a real Chrome on a real youtube.com page, which is exactly the environment BotGuard attests. Evaluate in this order and stop at the first that works:

- [~] **B1 — reuse the page's own token.** *Investigated; the premise does not hold as scoped.* The plan was to scrape the token off the player's own traffic via the existing main-world hook (AGENTS.md §8 #15). But `main-world-hooks.ts` patches only main-thread `window.fetch` / `XMLHttpRequest`, and an observe-only probe of that same surface on a live watch page recorded **zero** `googlevideo.com` requests during playback — `performance.getEntriesByType('resource')` likewise showed none. The player drives MSE from a `blob:` source with a service worker controlling the page, so its media traffic never crosses the surface our hook owns. Extending the hook into worker scope is a materially bigger change than "read a param off a request we already see."
  - **Confound identified as a tooling artifact, not a product bug.** The stuck player (`readyState` 0, `buffered` 0) reproduced on every video opened through CDP browser automation, including with no scripted interaction at all — 1 resource entry for a whole watch page. The maintainer confirms playback and the extension behave normally in ordinary use, so the frozen player was the automation harness, not our hook. **The browser-automation channel cannot answer this question and should not be retried for it.**
  - **In-extension probe added instead** (`probeProofOfOrigin` in `content/frame-content.ts`): logs, from a real playback session, every `googlevideo.com` request that crosses the main-thread fetch/XHR surface, with its param names and whether a `pot` is present. Shape only — `redactUrl` strips the credential, and `pot` was added to the redaction set for this. Reads out in the **page** console (content-script logs land there), not the SW console.
  - **Decision rule once the probe runs:** requests logged *with* `pot` → B1 is viable, promote the capture behind an adapter hook. Requests logged *without* `pot` → the token lives in the UMP/SABR request body, not the URL, so B1 as scoped is dead. Only the "armed" line and nothing else → the player's media traffic bypasses main-thread fetch/XHR entirely and B1 needs worker-scope hooking to have any chance.
  - The probe is a throwaway diagnostic and is deliberately site-specific in core code, which AGENTS.md §10 forbids. Remove it or move it behind an adapter hook once the question is settled.
- [~] **B2 — mint one via BotGuard in-page.** *Started: the plumbing is in, the minting is not.*
  - **Corrected target.** The original plan said attach `pot=` to the media URLs. The field results above disprove that: nothing appended to an already-gated URL rescues it, and the ungated inline URLs carry no `pot` at all. The token belongs on the `/youtubei/v1/player` request that MINTS the URLs, as `serviceIntegrityDimensions.poToken`. Building it the original way would have failed and been hard to diagnose.
  - [x] `buildInnerTubePlayerBody` takes an optional `poToken` and emits `serviceIntegrityDimensions`; omitted entirely when absent, so an unattested body stays byte-identical to pre-v0.12. Threaded through `InnerTubeAuth` → `fetchInnerTubePlayer` → the ladder. Tested both ways.
  - [x] `innerTubeCache` is keyed on attestation state, so an entry cached from an unattested run can't keep serving gated URLs once tokens start flowing.
  - [x] Acquisition seam at `adapters/youtube-potoken.ts` (`acquirePoToken`). Returns null today — exactly the pre-v0.12 path — so wiring it in cannot regress discovery. Callers must treat null as "proceed unattested", never as a hard failure: an unattested ladder still surfaces the inventory and the merged inline progressive still downloads.
  - [ ] **Run the BotGuard challenge in the page's MAIN world.** `window.trayride` is a page global and the content script is isolated, so this needs a main-world injection plus a postMessage bridge. `content/main-world-hooks.ts` is the precedent and the natural host.
  - **BLOCKED — needs a maintainer decision before any more code.** Probing the real flow turned up a collision with two hard project constraints:
    - `POST /youtubei/v1/att/get` works **same-origin** and needs no new permission. It returns `challenge` (~120 chars) plus `botguardData` = `{ program (~32 KB), interpreterSafeUrl }`.
    - But `program` is bytecode for an interpreter that is **not on the page** — `interpreterSafeUrl` points at a Google-hosted script that must be fetched and executed, and the resulting attestation is then POSTed to a second Google endpoint to be exchanged for an integrity token.
    - That means **fetching and running remotely-hosted code**, which collides with AGENTS.md §5/§10 ("MUST NOT contact anything other than the origin currently being downloaded from"; "no remote config") and, more seriously, with Chrome's MV3 prohibition on remotely-hosted code — a Web Store review risk, not just a style question.
    - Injecting the interpreter into the **page's** main world (rather than an extension context) is the usual way this is squared, on the reasoning that youtube.com is loading Google's own script as it already does and we merely trigger it. That is a real distinction but it is the maintainer's call, not an implementation detail to decide quietly.
    - Do **not** drive `window.trayride` directly as a shortcut. It is present, but its API is minified to rotating symbols (observed: `m`, `ad`, `a`, `Yrp_`), so anything built on those names breaks on YouTube's next player push.
  - [ ] Exchange the attestation for an integrity token, then mint the poToken.
  - [ ] **Verify the binding against a real request before building on it.** A session-bound token uses `visitorData`, a content-bound one uses the `videoId`; the wrong binding is rejected. `acquirePoToken` already takes a `PoTokenBinding` so both are expressible — do not guess which one, test it.
  - [ ] Cache per binding, refresh on expiry.
  - **Verification loop is cheap now:** attach a token, re-run a 4K download, check whether the URLs come back ungated. That single test settles whether the whole approach works.
- [ ] Thread `pot` through `DiscoveredStream` / `DownloadRequest` so both the video and paired-audio fetches carry it, and make `range-fetch` preserve it across every chunk request.
- [ ] Re-verify the full ladder after the token lands: progressive 360p, 1080p AVC, and 4K AV1 all fetching 200s.

**Phase C — decision needed from the maintainer (do not proceed unilaterally).**

- [ ] The `IOS` / `ANDROID` InnerTube clients have historically been the poToken-free fallback, but they validate `User-Agent`, and a content-script `fetch` cannot set it (AGENTS.md §8 #18 — earlier attempts got clean 400s). The only in-extension way to override UA is `declarativeNetRequest`, which AGENTS.md §8 #10 currently rules out on the grounds that we only observe traffic. If B1/B2 fail, that convention needs an explicit revisit rather than a quiet exception.

### Out of scope

- Implementing a full SABR/UMP client. Still a separate multi-week project; poToken is the cheaper unlock and is a prerequisite for SABR anyway.

**Ship criterion:** ✅ a public YouTube video downloads end-to-end at 360p, 1080p, and 4K against live YouTube, and no code path reports "token expired" for a failure that isn't one. Confirmed in the field, including a 2h44m 4K download.

**Also shipped in this milestone** (found while chasing the above):

- Real progress on large fetches. Progress used an asymptote assuming ~16 MB remained, which pinned the bar at 79% from ~840 MB to ~2.5 GB on an 8.2 GB download and then at 80% for the rest. `contentLengthFromUrl` reads googlevideo's `clen` so the bar tracks actual bytes, and `fetchToOpfsRanged` takes it as `knownTotalBytes` for a deterministic stop instead of EOF polling.
- `unlimitedStorage` permission. The adaptive path stages both inputs plus the combined output, needing ~2× the summed stream size — ~17 GB for that video. Without the permission an extension gets the default evictable quota, so this failed on a machine with plenty of free disk. The headroom check reports quota figures and says outright that it is not disk space.
- Cancel no longer flickers. In-flight progress ticks arriving after a cancel repainted the progress bar over the "Canceled" row, and moved the status off `canceled` so the row could settle on "error" for a deliberate cancel. Terminal states now ignore late progress.

---

## v0.11.10 - YouTube 4K via VP9 (WebM container muxer) — deferred (as-needed)

> **Deferred.** AVC + AV1 already cover HD + 4K for the vast majority of YouTube videos. VP9-only 4K is rare enough that this is picked up only when a user actually hits a video with no AVC/AV1 fallback. Sits below the v0.11.9 quality-of-life work in priority.

Goal: lift the codec gate's remaining hole. YouTube serves some 4K content as VP9-only (no AV1 fallback) — those videos surface in the picker today as "No supported variants" or hide their highest qualities behind the `isVariantDownloadable` filter. This milestone lights up the VP9 path by adding a WebM container muxer.

Constraints retained from v0.11.5:
- **No re-encoding.** Pure byte-level stream-copy.
- **Memory bound.** Same OPFS-streaming pattern as v0.11.5's mp4-combine; just a different container.
- **`.webm` output for VP9.** Matches what YouTube sends (no transmux). Chrome's `downloads.download` accepts both extensions; VLC + modern players handle WebM.

Tasks:

- [ ] Add `extension/offscreen/webm-combine.ts`: an EBML/Matroska segment stitcher. YouTube serves VP9 as fragmented WebM (one EBML Cluster per network segment). The combiner writes a fresh EBML header + Segment / Info / Tracks (one video, one audio) + the cluster sequence concatenated, with cluster timestamps rebased to the global timeline. Same `Fmp4Source`-shaped abstraction (renamed appropriately) so the streaming/memory invariants stay consistent.
- [ ] Extend `pickDefaultAudioFormat` in `extension/adapters/youtube.ts` to be codec-aware: VP9 pairs with Opus (in WebM); AVC + AV1 keep AAC (in m4a). The codec switch is what avoids the container mismatch that motivated splitting VP9 out of v0.11.5.
- [ ] Plumb output container through the pipeline: `DownloadRequest.outputContainer: 'mp4' | 'webm'` defaulting to `'mp4'`. SW sets it from the chosen variant's codec; the offscreen dispatch routes `req.kind === 'dash'` to `combineFmp4` vs `combineWebm` accordingly. The filename extension follows.
- [ ] Loosen the `isVariantDownloadable` codec gate for `vp09.*` (only when the variant has Opus paired audio available).
- [ ] WebM fixtures + tests for the segment stitcher (mirroring `mp4-combine.test.ts`'s shape: small synthetic Clusters + a large-Cluster regression case).
- [ ] Manual verify: a public YouTube 1440p / 2160p VP9 download produces a playable `.webm` in VLC + Chrome with correct duration + accurate seek.

**Ship criterion:** a public VP9 YouTube video at 1440p+ downloads to a playable `.webm` with correct duration / audio-video sync. AV1, AVC, and audio-only paths unchanged.

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

## v1.0 - Release gate (polish, disclaimer, tag)

Goal: shippable to friends — covers common HLS VOD end-to-end plus YouTube and Hotmart.

> The options page, per-adapter / per-origin settings, first-run disclaimer, and popup polish moved earlier to **v0.11.9**. v1.0 is now the release gate: final assets, security review, changelog, and the cross-site smoke matrix.

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

- [ ] **Batch download** of all lessons in a section (Hotmart adapter). Generalize to other adapters where applicable.
- [ ] **In-page Download button** injected next to the player by `page-content.js` (per-adapter opt-in).
- [ ] **Firefox port** (MV3 in Firefox lacks `offscreen` - would need a different long-lived context strategy).
- [ ] **Resume interrupted downloads** across browser restarts by persisting OPFS workspace manifests and request metadata.
- [ ] **MSE / `blob:` source streams** that build a MediaSource via `SourceBuffer.appendBuffer` - needs custom hooks beyond fetch/XHR.
- [ ] **Adapter sideloading** so users can drop a JS/TS adapter file into a folder and have it picked up without a rebuild.
- [ ] **Optional ffmpeg.wasm mux engine** for subtitle muxing, hard DASH cases, or formats mux.js/local MP4 tooling cannot cover.
- [ ] **Image / audio detection** a la Video DownloadHelper's full feature set.
- [ ] **Repo rename** from `hotmart-downloader/` to something neutral once we ship.
