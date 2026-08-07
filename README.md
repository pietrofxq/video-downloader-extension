# Video Downloader

A Chrome extension (Manifest V3) that finds the video playing on a page and saves it as a plain MP4 — no re-encoding, no external tools, nothing leaves your browser.

It watches for streaming manifests on any site and hands them to a generic download engine. On top of that sits a **site-adapter** layer for places that need special handling: **YouTube** and **Hotmart Club** have dedicated adapters today, and everything else falls back to a default adapter that works on most ordinary players.

> **Disclaimer.** This tool is for content you have the right to download — content you own, have purchased access to, or that is freely licensed. Don't use it to redistribute copyrighted material. DRM-protected streams (Widevine / PlayReady / FairPlay) are explicitly out of scope and always will be.

## What it can download

Current coverage as of **v0.11.11**:

| Source | Status | Notes |
|---|---|---|
| **YouTube** | ✅ up to 4K | 2160p in **AVC** and **AV1**. Multi-dub videos get an audio-track picker. Public, non-DRM watch pages only. |
| **HLS** (`.m3u8`) | ✅ | Including AES-128 encrypted segments. Covers the common case where audio and video are muxed together in MPEG-TS. |
| **Progressive** (`.mp4`, `.webm`) | ✅ | Direct file URLs the player fetches. |
| **DASH** (`.mpd`) | ⚠️ detected only | Generic MPDs are listed in the popup but can't be downloaded yet — see v1.2 in the [roadmap](ROADMAP.md). |
| **DRM** | ❌ never | Widevine / PlayReady / FairPlay are out of scope by design. |

Known gaps worth stating plainly:

- **VP9-only YouTube videos** appear in the quality picker but won't download. VP9 ships in fragmented WebM, which needs a different container muxer (v0.13, picked up as needed). Almost every video also offers AVC or AV1, so this is rare in practice.
- **HLS alternate audio.** Masters that declare separate audio renditions (`#EXT-X-MEDIA TYPE=AUDIO`) are detected, but only the video rendition is downloaded. Muxing them together is v0.12.
- **Subtitles** aren't implemented yet (v1.1).
- YouTube **rentals, age-gated, region-locked, and live** content are out of scope.

### A note on large downloads

4K is genuinely large. A 2h44m 2160p video is about **8 GB**, and the extension needs roughly **twice that** in browser storage while it works, because it stages the video and audio streams separately before combining them. That's why it requests the `unlimitedStorage` permission. If you're short on space it will tell you up front, with real numbers, instead of failing hours in.

## Install

The extension isn't on the Chrome Web Store — you install it as an **unpacked extension** from a prebuilt zip. It works in Chrome, Edge, Brave, and other Chromium-based browsers.

1. **Download** the latest `video-downloader-vX.Y.Z.zip` from the [**Releases** page](https://github.com/pietrofxq/video-downloader-extension/releases/latest).
2. **Unzip** it. You'll get a `video-downloader/` folder containing `manifest.json`.
3. Open `chrome://extensions` (or `edge://extensions` / `brave://extensions`).
4. Turn on **Developer mode** — the toggle is in the top-right corner.
5. Click **Load unpacked** and select the unzipped `video-downloader/` folder.
6. Pin the icon to your toolbar.

**To update:** download the newer zip, unzip it over the old folder, then hit **Reload** ↻ on the extension's card in `chrome://extensions`.

> **About that permission warning.** Chrome will say the extension can *"read and change all your data on all websites."* That breadth is unavoidable: the engine has to watch network requests and fetch video segments on **whatever site you're downloading from**, which could be any site. In exchange, it makes **no other network calls at all** — no analytics, no telemetry, no remote servers, no auto-update pings ([why](AGENTS.md#5-key-architectural-decisions)). Everything happens locally in your browser.

## Usage

1. Open a page with a video and **press play for a second or two** — the extension needs the player to actually request its manifest before it can see anything.
2. Click the toolbar icon. The popup lists every stream detected on the current tab, each tagged with the adapter that matched it.
3. Pick a **quality** (defaults to the best available, or to whatever you set in options), and an **audio track** if the video has several dubs.
4. Click **Download**. The file lands in your normal downloads folder.

While a download runs you can watch its progress, **cancel** it, and start others — they queue up. Finished rows offer **Show in folder**, and failed ones offer **Retry**. If a download fails, the popup tells you why in plain language rather than showing a generic error.

**On Hotmart Club**, none of this changes: the adapter activates on `hotmart.com/*/club/*`, handles the cross-origin player and signed tokens for you, and names files `{section} - {lesson}.mp4`.

## Settings

The options page (right-click the icon → **Options**) covers:

- **Default quality**, so you don't re-pick it every time. The popup also remembers the last quality you chose manually.
- **Parallel segment downloads** — raise it for speed, lower it if a site rate-limits you.
- **Filename templates**, per adapter.
- **Per-origin blocking** and **per-adapter toggles**, to silence detection where you don't want it.
- **Clear captured data** — drops any auth state the extension is holding.

## How it works

The extension watches each tab two ways at once: `webRequest` listeners in the service worker, and a `document_start` content script that hooks `fetch` and `XMLHttpRequest` in the page and every iframe. Both are needed — `webRequest` sees URLs but not headers added by JavaScript, and the hook catches requests that only appear once playback starts.

When a media URL turns up:

1. **Capture** the URL along with whatever auth it needs. Cookies ride along automatically; some sites embed short-lived signed tokens in the URL itself; others use `Authorization` headers, which the frame hook forwards.
2. **Route** it to a **site adapter** matched on the page's origin. Adapters improve metadata, fix up filenames, and handle site-specific quirks. Anything unclaimed falls to the default adapter.
3. **List** it in the popup — one row per video, with a quality dropdown and format badges.
4. **Download and repackage** in an offscreen document: fetch the segments, decrypt if needed (AES-128 for HLS — no DRM), and remux to MP4 by **stream copy**. The video is never re-encoded, so there's no quality loss and it's fast.
5. **Save** through `chrome.downloads.download`.

Two details that took real work: the remuxer patches the `moov` / `moof` boxes that `mux.js` emits, because its output targets browser playback and needs fixing before VLC and QuickTime will show correct durations and seek properly. And large downloads stream through OPFS rather than living in memory, so a multi-gigabyte 4K file doesn't exhaust the browser. `AGENTS.md` §8 documents both in detail.

## Site adapters

Every site runs the same pipeline — detect, route, download, remux. Adapters only override what they need.

### Default — every site

Matches everything, at lowest priority. Takes metadata from the page `<title>` and Open Graph tags, names files `{title} - {url basename}`, and fetches the media URL the player already requested. No signing, no cross-origin tricks. Good enough for most players.

### YouTube — `adapters/youtube.ts`

YouTube never gives the page a usable media URL, so this adapter does real work:

- **The catalog comes from InnerTube, not the page.** Modern YouTube's web player ships format metadata with **no URLs** (SABR). The adapter POSTs to `/youtubei/v1/player` from the content script, so the request carries a genuine `youtube.com` origin.
- **Client choice is load-bearing.** It asks as `ANDROID_VR`, which is the client whose media URLs the CDN actually serves — other clients return a full catalog whose URLs are refused. This needs the session's `visitorData` and specifically *not* the web account auth header.
- **Signature and `n`-param decipher**, where a URL needs it. The transform lives in an obfuscated function inside YouTube's `base.js`; the adapter extracts it via AST analysis and runs it in a sandboxed iframe, since MV3's CSP forbids `Function()` in the offscreen document.
- **Video and audio are separate files** at HD and above. Both are fetched in parallel via chunked Range requests, staged in OPFS, then de-fragmented into a single plain MP4 — stream copy throughout.
- **SPA navigation** is handled, so clicking through to another video updates the popup without a reload.

### Hotmart Club — `adapters/hotmart.ts`

The player sits in a cross-origin iframe behind a signed token, which the default adapter can't reach:

- **Cross-origin iframe.** The player runs on `cf-embed.play.hotmart.com`, whose DOM the top-page script can't read. Stream URLs and metadata are relayed out through that frame's own content script.
- **Signed Akamai tokens (`hdntl`).** Segment URLs are short-lived and must be fetched *from the iframe's origin* — an extension-origin fetch gets a 403. All segment, key, and manifest fetches are proxied through the frame. Start a download long after capture and the token can expire, which the popup reports as such.
- **AES-128 HLS.** The key is fetched once and segments are decrypted with Web Crypto before remux.
- **Naming** is scraped from the lesson and section headings: `{section} - {lesson}.mp4`.

## Project layout

```
extension/
├── manifest.json
├── background/
│   └── service-worker.ts     # webRequest capture, adapter dispatch, download orchestration
├── content/
│   ├── page-content.ts       # top frames: page metadata + adapter stream discovery
│   ├── frame-content.ts      # all frames: message bridge + origin-correct fetch proxy
│   └── main-world-hooks.ts   # page world: fetch / XHR instrumentation
├── adapters/
│   ├── index.ts              # registry + pickAdapter(pageUrl, mediaUrl)
│   ├── default.ts            # fallback: <title> + URL basename
│   ├── hotmart.ts            # cross-origin iframe, hdntl tokens, lesson naming
│   ├── youtube.ts            # InnerTube catalog, variants, dub tracks
│   ├── youtube-clients.ts    # InnerTube client table (ANDROID_VR first)
│   └── youtube-auth.ts       # SAPISIDHASH + visitorData session binding
├── offscreen/
│   ├── downloader.ts         # HLS pipeline: fetch, decrypt, remux orchestration
│   ├── adaptive.ts           # YouTube HD/4K: two streams fetched, staged, combined
│   ├── progressive.ts        # single-file downloads
│   ├── range-fetch.ts        # chunked Range fetches, OPFS-staged
│   ├── mp4-combine.ts        # de-fragmenting two-track MP4 combiner
│   ├── remux.ts              # mux.js driver + moov / moof patcher
│   ├── hls-decrypt.ts        # AES-128-CBC + IV derivation
│   ├── yt-sig.ts             # base.js signature / n-param solver
│   ├── sandbox.ts            # isolated eval for the solver
│   └── storage.ts            # OPFS workspace per download
├── popup/                    # detected videos, quality + audio pickers, active downloads
├── options/                  # defaults, filename templates, per-site controls
└── lib/                      # messaging, types, settings, sanitizing, logging
```

`AGENTS.md` holds the architectural notes and the hard-won gotchas; `ROADMAP.md` tracks milestones.

## Build from source

```bash
npm install
npm run build        # or: npm run build:prod  (minified)
```

Then load `dist/` as an unpacked extension. `npm run check` runs the full gate — format, lint, typecheck, tests, build — and must pass before anything ships.

Releases are automated: pushing a `vX.Y.Z` tag triggers the [release workflow](.github/workflows/release.yml), which runs the check, does a production build, and publishes a GitHub Release with the zip attached.

## Status

Beta, and used daily. See [ROADMAP.md](ROADMAP.md) for what's next.

## License

TBD.
