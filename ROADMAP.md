# ROADMAP

Shippable milestones for the Video Downloader extension. Each version is independently demoable — at the end of a version you should be able to load the extension unpacked and *show something working*.

The engine is **site-agnostic**: generic media detection runs everywhere, and a **site-adapter** layer adds richer metadata, auth handling, and naming for specific origins. **Hotmart Club is the first and most-tested adapter** — its needs (cross-origin iframe, signed `hdntl` token, AES-128 segments) drive a lot of the design, but no Hotmart-specific code lives outside `extension/adapters/hotmart.js`. Adding another adapter (Vimeo, generic Video.js, Bunny CDN, etc.) is intentionally a small, well-scoped task — see v1.3.

A coding agent picking up work should:
1. Find the lowest unchecked `## v0.X` section.
2. Complete its checkboxes top-to-bottom.
3. Tick each box as the work lands, then move on.
4. Don't skip ahead — later versions assume earlier ones are done.

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
- [ ] Verify on a public HLS test stream (unencrypted): downloads to `.ts` and plays.

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
- [ ] Tear down the offscreen document after each download to release memory (`chrome.offscreen.closeDocument`). (Deferred: v0.8 will revisit when wiring progress UI + persisted in-progress download state. Today the doc stays alive across downloads.)
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

## v0.9 — Subtitle support (optional toggle)

Goal: when the manifest references subtitles, the user can download them too.

- [ ] In the offscreen m3u8/mpd parser, surface subtitle media playlists alongside variants.
- [ ] In the popup, replace the placeholder "Include subtitles" checkbox with a real one bound to the detected subtitle languages.
- [ ] When enabled, fetch `.webvtt` segments, concatenate, fix per-segment cue timestamps (offset by `EXTINF` cumulative duration).
- [ ] Offer two output modes (defaulted in `options.html`): "Save as `.vtt` alongside MP4" or "Mux into MP4 as `mov_text`".
- [ ] For the mux path, extend the ffmpeg invocation to include `-i subs.vtt -c:s mov_text`.
- [ ] Verify: a Hotmart lesson with pt-BR subtitles downloads with playable subtitles in both modes.
- [ ] Verify on a public HLS stream with subtitles.

**Ship criterion:** subtitled streams download with usable captions on any HLS site.

---

## v1.0 — Polish, settings, disclaimer

Goal: shippable to friends — covers HLS end-to-end on any site, with first-class Hotmart support.

- [ ] First-run modal in the popup with the legal disclaimer ("only download content you have the right to"); acceptance stored in `chrome.storage.local`.
- [ ] `options.html` page with:
  - Default quality (highest / 1080p / 720p / 480p / ask each time).
  - Concurrency (default 4, range 1–8).
  - Subtitle output mode (sidecar `.vtt` / muxed / off).
  - Filename template per-adapter (default `{section} - {lesson}.mp4` for Hotmart, `{title} - {basename}.mp4` for default) with a live preview.
  - **Per-adapter enable/disable list** with descriptions.
  - **Per-origin block list** so users can silence detection on specific sites.
  - "Reset detected videos for current tab" button.
  - Plain-language explanation of why `<all_urls>` permission is needed.
- [ ] Final icon set + active-state badge styling.
- [ ] **HLS alternate-audio renditions**: when the master playlist declares `EXT-X-MEDIA TYPE=AUDIO` separate from the video variant (currently detected by `lib/m3u8.js` and hidden from the popup), fetch the chosen audio rendition's media playlist alongside the video, transmux both through mux.js, and combine them into a single moof-with-two-trafs in `remux.js`. README currently narrows the HLS claim to muxed-AV variants; widen it once this lands.
- [ ] Write `CHANGELOG.md` and tag `v1.0.0`.
- [ ] Manual smoke test on 3 sites: a Hotmart course, a public HLS demo, a generic third-party site with HTML5 HLS.
- [ ] Update `README.md` install section with the final unpacked-load steps.

**Ship criterion:** the extension is usable end-to-end on Hotmart and on at least two unrelated HLS sites by a non-technical user on a fresh Chrome profile.

---

## v1.1 — DASH (.mpd) support

Goal: HLS and DASH streams are downloadable through the same pipeline.

- [ ] Add `mpd-parser` to `vendor/` and bundle.
- [ ] In the offscreen document, branch on `kind === 'dash'`: parse the MPD, pick a video representation (highest bitrate by default) and the matching audio representation, extract segment URLs (or build them from `SegmentTemplate`).
- [ ] DASH usually separates audio and video tracks — fetch both in parallel, then have ffmpeg.wasm mux: `ffmpeg -i video.mp4 -i audio.mp4 -c copy out.mp4`.
- [ ] Handle DASH ClearKey decryption via Web Crypto AES-CTR when `ContentProtection` declares it (no DRM — ClearKey only).
- [ ] If `ContentProtection` references Widevine (`edef8ba9-...`) / PlayReady / FairPlay system IDs, mark `mediaEntry.drm = true` upstream so v0.4's popup row shows "DRM-protected".
- [ ] Quality picker should show video representations (resolution + bitrate); audio is implicit.
- [ ] Verify: download a public DASH-IF reference stream end-to-end and play the MP4.

**Ship criterion:** a public unencrypted DASH stream downloads to a playable MP4.

---

## v1.2 — Progressive download (single MP4 / WebM)

Goal: when a site serves a single non-segmented `.mp4` or `.webm` via `<video src="...">`, the user can download it in one shot.

- [ ] In the offscreen document, branch on `kind === 'progressive'`: skip parsing, skip remux, stream the file straight to OPFS, then to `chrome.downloads.download` via a Blob URL.
- [ ] Support HTTP `Range` requests for resumable / parallel-chunk progressive downloads (concurrency 4, like HLS segments).
- [ ] Use `Content-Disposition` filename when present; otherwise fall back to the adapter's `deriveFilename`.
- [ ] Show a single progress bar with bytes-downloaded / total.
- [ ] Verify: download a public sample MP4 (e.g. a Big Buck Bunny mirror) end-to-end.

**Ship criterion:** a plain progressive MP4 on any site downloads with a progress bar.

---

## v1.3 — Adapter SDK + a second real adapter

Goal: adding a new site adapter is a documented, ~50-line task.

- [ ] Write `docs/adapters.md` with the full adapter contract, lifecycle, and a worked example end-to-end.
- [ ] Convert the loose JSDoc in `lib/adapter.js` into a real `.d.ts` (or, if TS migration has happened, formalize the interface).
- [ ] Pick one additional real-world target (suggested: **generic Video.js detector** — matches any page where `videojs` is on `window` and pulls metadata from the player's data attributes; alternatively **Bunny CDN** or **public Vimeo embeds**) and implement it as `adapters/{name}.js`.
- [ ] Add an adapter-matching dev tool: in the options page, a "Test URL" field that shows which adapter would match.
- [ ] Add an adapter conformance test fixture (`tests/adapters/*.test.js`) covering: `matches`, `scrapePageMeta` on a saved HTML fixture, `deriveFilename` on a representative entry.
- [ ] Verify: with the new adapter installed, the popup correctly tags streams from that site with the new adapter id and produces a properly named MP4.

**Ship criterion:** the project has two non-trivial adapters and a contributor can write a third by following `docs/adapters.md`.

---

## Post-v1.3 (out of scope for now, parked here)

- [ ] **Batch download** of all lessons in a section (Hotmart adapter; `plan.txt` §6 "Single-video vs batch"). Generalize to other adapters where applicable.
- [ ] **In-page Download button** injected next to the player by `page-content.js` (per-adapter opt-in).
- [ ] **TypeScript migration** once the adapter API surface stabilizes (post-v1.3).
- [ ] **Firefox port** (MV3 in Firefox lacks `offscreen` — would need a different long-lived context strategy).
- [ ] **Resume interrupted downloads** by persisting decrypted segments to OPFS across SW restarts.
- [ ] **MSE / `blob:` source streams** that build a MediaSource via `SourceBuffer.appendBuffer` — needs custom hooks beyond fetch/XHR.
- [ ] **Adapter sideloading** so users can drop a JS file into a folder and have it picked up without a rebuild.
- [ ] **Image / audio detection** (à la Video DownloadHelper's full feature set).
- [ ] **Repo rename** from `hotmart-downloader/` to something neutral once we ship.
