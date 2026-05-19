# Video Downloader (with Hotmart Club support)

A Chrome extension (Manifest V3) that detects and downloads streaming video from arbitrary websites — HLS (`.m3u8`), DASH (`.mpd`), and progressive (`.mp4` / `.webm`) — through a generic media-detection engine plus a pluggable **site-adapter** layer that adds richer metadata, auth handling, and naming for specific sites. **Hotmart Club is the first first-class adapter**: it handles the cross-origin iframe, the signed Akamai token, and the AES-128 decryption automatically.

> **Current HLS coverage** (v0.7): variant playlists whose segments carry both audio and video muxed into MPEG-TS (the common case, including Hotmart). Masters with separate alternate-audio renditions (`#EXT-X-MEDIA TYPE=AUDIO`) are detected but only the video rendition is downloaded — audio-rendition muxing is on the roadmap.

> **Disclaimer**: This tool is intended for users who have the right to download the content they target — content they own, have purchased access to, or that is freely licensed. Do not use it to redistribute copyrighted material. DRM-protected streams (Widevine / PlayReady / FairPlay) are explicitly out of scope.

## How it works

The extension watches every tab for media manifests using both `webRequest` listeners (in the service worker) and a `document_start` content script that hooks `fetch` and `XMLHttpRequest` in the top page and every iframe. When a `.m3u8`, `.mpd`, or progressive media URL is seen, the extension:

1. **Captures** the URL plus any auth context it needs — cookies are sent automatically; some sites (like Hotmart) embed short-lived signed tokens directly in the URL; others use `Authorization` headers that the frame hook forwards alongside the URL.
2. **Routes** the detection through a **site adapter** matched by the page origin. Adapters can rename the file, supply better metadata, and apply site-specific quirks. Unknown sites fall back to the **default adapter**, which uses the page `<title>` and the URL filename.
3. **Lists detected videos** in the popup UI — one row per stream, with source-site adapter badge, quality dropdown, format/encryption badges, and a Download button.
4. **Downloads** segments, decrypts when needed (AES-128 for HLS, ClearKey AES-CTR for DASH — no DRM), and **remuxes to fragmented MP4** (stream copy — no re-encoding) using `mux.js` inside an offscreen document. The remux step also patches the moov / moof boxes after `mux.js` produces them (see `AGENTS.md` §8 for the specific quirks).
5. Saves the resulting MP4 via `chrome.downloads.download`.

For Hotmart Club specifically: the player runs in a cross-origin iframe (`cf-embed.play.hotmart.com`) streaming HLS-packaged, AES-128 encrypted segments signed with a short-lived Akamai token (`hdntl`). The Hotmart adapter handles all of that automatically — the user just presses play and clicks Download.

## File structure

```
hotmart-downloader/
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
├── README.md                        # this file
└── plan.txt                         # original product spec (Hotmart-specific)
```

> The repo root is still named `hotmart-downloader/` for historical reasons; renaming is parked for post-v1.3.

## Installation (development)

1. Clone this repository.
2. Run `npm install` and `npm run build` (once the build pipeline is in place — see [ROADMAP.md](ROADMAP.md)).
3. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the build output (`dist/`).
4. Open any page with a video and press **Play** for ~2 seconds, then click the extension icon.

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

Pre-alpha — see [ROADMAP.md](ROADMAP.md) for the current milestone and remaining work.

## License

TBD.
