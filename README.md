# Video Downloader

A Chrome extension (Manifest V3) that detects and downloads streaming video from any website — HLS (`.m3u8`), DASH (`.mpd`), and progressive (`.mp4` / `.webm`) — through a generic media-detection engine plus a pluggable **site-adapter** layer that adds richer metadata, auth handling, and naming for specific sites. It works on most sites out of the box; **YouTube and Hotmart Club have dedicated adapters** today, and support for more sites is added as needed.

> **Current coverage** (v0.11.9):
> - **HLS** — variant playlists whose segments carry audio and video muxed into MPEG-TS (the common case, including Hotmart). Masters with separate alternate-audio renditions (`#EXT-X-MEDIA TYPE=AUDIO`) are detected but only the video rendition is downloaded — audio-rendition muxing is on the v0.12 roadmap.
> - **YouTube** — adaptive HD (1080p) and 4K (2160p) for **AVC** and **AV1** codecs. The full pipeline is wired: InnerTube scrape (WEB_CREATOR / MWEB / TVHTML5) for catalog, SAPISIDHASH + visitorData auth, signatureCipher + n-param decipher, OPFS-staged chunked Range fetches, and an OPFS-streaming two-stream combiner that de-fragments video + audio into one plain MP4 (so seeking + A/V sync are correct in VLC). Public non-DRM watch pages only; rentals, age-gated, region-locked, and live content are out of scope. **VP9** variants surface in the picker but stay rejected — they're in fragmented WebM, which needs a different container muxer (deferred, picked up as needed). Multi-dub videos get an audio-track picker; default pairs the original track.

> **Disclaimer**: This tool is intended for users who have the right to download the content they target — content they own, have purchased access to, or that is freely licensed. Do not use it to redistribute copyrighted material. DRM-protected streams (Widevine / PlayReady / FairPlay) are explicitly out of scope.

## How it works

The extension watches every tab for media manifests using both `webRequest` listeners (in the service worker) and a `document_start` content script that hooks `fetch` and `XMLHttpRequest` in the top page and every iframe. When a `.m3u8`, `.mpd`, or progressive media URL is seen, the extension:

1. **Captures** the URL plus any auth context it needs — cookies are sent automatically; some sites (like Hotmart) embed short-lived signed tokens directly in the URL; others use `Authorization` headers that the frame hook forwards alongside the URL.
2. **Routes** the detection through a **site adapter** matched by the page origin. Adapters can rename the file, supply better metadata, and apply site-specific quirks. Unknown sites fall back to the **default adapter**, which uses the page `<title>` and the URL filename.
3. **Lists detected videos** in the popup UI — one row per stream, with source-site adapter badge, quality dropdown, format/encryption badges, and a Download button.
4. **Downloads** segments, decrypts when needed (AES-128 for HLS, ClearKey AES-CTR for DASH — no DRM), and **remuxes to fragmented MP4** (stream copy — no re-encoding) using `mux.js` inside an offscreen document. The remux step also patches the moov / moof boxes after `mux.js` produces them (see `AGENTS.md` §8 for the specific quirks).
5. Saves the resulting MP4 via `chrome.downloads.download`.

## Supported sites & adapter quirks

Every site runs through the same engine (detect → route to an adapter → download → remux). The **default adapter** matches everything and is the baseline; sites with a dedicated adapter override only what they need on top of it.

### Default adapter (fallback — every site)

- **Matches:** always (lowest priority; runs when no specific adapter claims the page).
- **Metadata:** page `<title>` + Open Graph tags; filename `{title} - {url basename}`.
- **Fetching:** the media URL the player already requested, with cookies sent automatically. No URL signing, no cross-origin handling.
- **Best for:** any site that serves a normal HLS / DASH / progressive URL the player fetches directly.

### YouTube — `adapters/youtube.ts`

YouTube never hands the page a usable media URL, so the adapter does real work the default never has to:

- **Catalog comes from InnerTube, not the page.** Modern YouTube's WEB-client `ytInitialPlayerResponse` ships format metadata with **no URLs** (SABR). The adapter POSTs to `/youtubei/v1/player` **from the content-script context** (so Origin/Referer are `youtube.com`) using non-WEB clients (IOS / TVHTML5 / …) that still return URLs, authenticated with a `SAPISIDHASH` header + `visitorData`.
- **Signature + n-param decipher.** Each `googlevideo` URL carries a `signatureCipher` / `n` value that must be transformed by a function buried in YouTube's `base.js`. The adapter AST-extracts that function and evaluates it inside a **sandboxed iframe** (MV3 CSP forbids `Function()` in the offscreen document).
- **Two separate streams, combined.** HD/4K video and audio are independent files. They're fetched in parallel (chunked Range, OPFS-staged) and **de-fragmented into one plain MP4** — stream copy, no re-encode.
- **Multi-dub audio picker** when a video ships several audio tracks (defaults to the original), plus **SPA-navigation handling** (the watch page swaps videos without reloading).
- **Codecs:** AVC + AV1, including 4K. VP9-only videos surface in the picker but aren't downloadable yet (deferred). Public non-DRM watch pages only — rentals, age-gated, region-locked, and live are out of scope.

### Hotmart Club — `adapters/hotmart.js`

The player is locked inside a cross-origin iframe behind a signed token, which the default adapter can't reach:

- **Cross-origin iframe.** The player runs in `cf-embed.play.hotmart.com`, whose DOM the top-page content script can't read. Stream URLs and metadata are relayed out through the iframe's own content script via messages.
- **Signed Akamai token (`hdntl`).** Segment URLs are signed with a short-lived token, and fetches must originate from the **iframe's** origin (an extension-origin fetch gets 403'd). Segment / key / manifest fetches are therefore proxied through the iframe. A download started more than ~5 minutes after capture can hit token expiry → a "reload the page and try again" error.
- **AES-128 HLS.** Segments are AES-128-CBC encrypted; the key is fetched once and segments are decrypted with Web Crypto before remux.
- **Naming.** Filenames are scraped from the lesson + section in the player chrome: `{section} - {lesson}.mp4`.
- Activates on `hotmart.com/*/club/*`; the user just presses play and clicks Download.

## File structure

```
video-downloader-extension/
├── extension/
│   ├── manifest.json
│   ├── background/
│   │   └── service-worker.js        # webRequest capture + adapter dispatch + download orchestration
│   ├── content/
│   │   ├── page-content.js          # injected into all http(s) top frames: page metadata
│   │   └── frame-content.js         # injected into all frames at document_start: fetch/XHR hooks
│   ├── adapters/
│   │   ├── index.js                 # adapter registry + pickAdapter(url, pageUrl)
│   │   ├── default.js               # fallback adapter: page <title> + URL filename
│   │   └── hotmart.js               # Hotmart Club: lesson/section scrape, hdntl handling
│   ├── popup/
│   │   ├── popup.html               # detected videos list + download controls
│   │   ├── popup.css
│   │   └── popup.js
│   ├── offscreen/
│   │   ├── offscreen.html
│   │   ├── offscreen.js             # message router for the offscreen context
│   │   ├── downloader.js            # HLS pipeline: fetch + AES-128 decrypt + remux orchestration
│   │   ├── hls-decrypt.js           # Web Crypto AES-CBC + IV derivation from media sequence
│   │   └── remux.js                 # mux.js Transmuxer driver + moov / moof post-patcher
│   ├── options/
│   │   ├── options.html             # defaults, per-adapter enable/disable, disclaimer
│   │   └── options.js
│   ├── lib/                         # shared modules (messaging, sanitize, url helpers, adapter API)
│   └── icons/
│       ├── icon-16.png
│       ├── icon-32.png
│       ├── icon-48.png
│       ├── icon-128.png
│       └── icon-active.png          # toolbar badge state when videos are detected
├── docs/
│   ├── adapters.md                  # how to write a new site adapter (added in v1.3)
│   └── screenshots/
├── AGENTS.md                        # architectural notes for coding agents
├── ROADMAP.md                       # shippable milestones / checkboxes
└── README.md                        # this file
```

## Install

The extension isn't on the Chrome Web Store — you install it as an **unpacked extension** from a prebuilt zip. It works in Chrome, Edge, Brave, and other Chromium-based browsers.

1. **Download** the latest `video-downloader-vX.Y.Z.zip` from the [**Releases** page](https://github.com/pietrofxq/video-downloader-extension/releases/latest).
2. **Unzip** it. You'll get a `video-downloader/` folder that contains `manifest.json`.
3. Open `chrome://extensions` in your browser (or `edge://extensions` / `brave://extensions`).
4. Turn on **Developer mode** (toggle in the top-right corner).
5. Click **Load unpacked** and select the unzipped `video-downloader/` folder.
6. The Video Downloader icon appears in your toolbar — pin it for easy access.

> **Heads-up on permissions:** the browser will warn that the extension can *"read and change all your data on all websites."* That breadth is required — the engine has to watch network requests and fetch video segments on **any** site you download from. It makes **no other network calls**: no analytics, no telemetry, no remote servers ([why](AGENTS.md#5-key-architectural-decisions)). All processing happens locally in your browser.

**To update:** download the newer zip, unzip it (over the old folder or into a new one), then click the **Reload** ↻ button on the extension's card in `chrome://extensions`.

## Build from source (for developers)

1. Clone this repository.
2. Run `npm install`, then `npm run build` (or `npm run build:prod` for a minified build).
3. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the build output (`dist/`).
4. Open any page with a video and press **Play** for ~2 seconds, then click the extension icon.

Releases are automated: pushing a `vX.Y.Z` tag triggers the [release workflow](.github/workflows/release.yml), which runs `npm run check`, does a production build, and publishes a GitHub Release with the `video-downloader/` zip attached. See [ROADMAP.md](ROADMAP.md) for milestone status.

## Usage

**On any site:**
1. Open a page that has a video player.
2. Press play for 1–2 seconds so the player fetches its manifest (the extension intercepts it).
3. Click the extension's toolbar icon. The popup lists every detected stream on the current tab, tagged with the adapter that matched.
4. Pick a **quality** from the dropdown (defaults to highest), optionally toggle **subtitles**, then click **Download MP4**.
5. The file is saved to your default Chrome downloads folder. By default the name is `{page title} - {video filename}.mp4`; per-site adapters can supply a better template.

**On Hotmart Club specifically:**
The Hotmart adapter activates automatically on `hotmart.com/*/club/*`. The download is named `{section} - {lesson}.mp4` and the cross-origin iframe + signed token are handled transparently.

## Status

Beta — see [ROADMAP.md](ROADMAP.md) for the current milestone and remaining work.

## License

TBD.
