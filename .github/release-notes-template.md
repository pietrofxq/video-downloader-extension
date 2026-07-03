Prebuilt **Manifest V3** build of the Video Downloader extension for Chromium browsers (Chrome, Edge, Brave, …). Detects **HLS / DASH / progressive** video, with dedicated adapters for **YouTube** and **Hotmart Club**.

## Install

1. Download **`__ZIP__`** from the **Assets** below.
2. **Unzip** it — you'll get a `video-downloader/` folder that contains `manifest.json`.
3. Open `chrome://extensions` (or `edge://extensions` / `brave://extensions`).
4. Turn on **Developer mode** (toggle, top-right).
5. Click **Load unpacked** and select the unzipped `video-downloader/` folder.
6. Pin the toolbar icon. On any page, play a video for ~2 seconds, then click the icon to see detected streams.

> The browser will warn that the extension can _"read and change all your data on all websites."_ That breadth is required — the engine watches network requests and fetches video segments on **any** site you download from. It makes **no other network calls**: no analytics, no telemetry, no remote servers. Everything runs locally in your browser.

See the [README](https://github.com/__REPO__#readme) for supported sites, adapter details, and usage.

> **Disclaimer:** intended for content you have the right to download (owned, purchased, or freely licensed). DRM-protected streams (Widevine / PlayReady / FairPlay) are out of scope.
