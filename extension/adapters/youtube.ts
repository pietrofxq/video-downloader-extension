import { log } from '../lib/log.js';
import { sanitizeFilename } from '../lib/sanitize-filename.js';
import type { Adapter, DiscoveredStream, HlsVariant, PageMeta } from '../lib/types.ts';

// Match watch / shorts / embed under the canonical YouTube hosts, plus
// the youtu.be short-link form. We deliberately don't match the home
// page, channel pages, or playlist-only URLs — there's no single video
// to download from those.
function isYouTubePage(pageUrl: string): boolean {
  try {
    const u = new URL(pageUrl);
    const host = u.hostname;
    if (host === 'youtu.be') {
      // youtu.be/<videoId> — the path identifies the video.
      return u.pathname.length > 1;
    }
    if (host !== 'www.youtube.com' && host !== 'youtube.com' && host !== 'm.youtube.com') {
      return false;
    }
    const path = u.pathname;
    return (
      path === '/watch' ||
      path.startsWith('/shorts/') ||
      path.startsWith('/embed/') ||
      path.startsWith('/live/')
    );
  } catch {
    return false;
  }
}

// `<title>` on a watch page is "Video Title - YouTube" (or localized
// variant). og:title carries just the video title and is the preferred
// source; fall back to stripping the trailing " - YouTube" from the
// document title.
function stripYouTubeSuffix(title: string): string {
  return title.replace(/\s+-\s+YouTube\s*$/i, '').trim();
}

/**
 * Walk a JSON object literal starting at `text[start]` (which must be
 * `{`). Returns the JSON substring including the closing brace, or null
 * if the structure is malformed. Used to extract YouTube's inline JSON
 * blobs out of `<script>` bodies without involving Function() / eval.
 */
function extractJsonObject(text: string, start: number): string | null {
  if (text[start] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// Shape we care about from ytInitialPlayerResponse. Keep this narrow —
// YouTube rotates field names occasionally, and the strict shape limits
// the blast radius when something moves. Untouched fields can stay
// untyped (`unknown`).
export interface YtPlayerResponse {
  videoDetails?: {
    videoId?: string;
    title?: string;
    author?: string;
    lengthSeconds?: string;
  };
  microformat?: {
    playerMicroformatRenderer?: {
      ownerChannelName?: string;
    };
  };
  playabilityStatus?: {
    status?: string;
    reason?: string;
  };
  streamingData?: {
    formats?: YtFormat[];
    adaptiveFormats?: YtFormat[];
  };
}

interface YtFormat {
  itag?: number;
  url?: string;
  /** Newer YouTube serves the URL as `s` (sig) + `sp` (sigParam) inside
   * this percent-encoded query string. v0.11 doesn't decode it yet — we
   * skip formats that lack a direct `url`. */
  signatureCipher?: string;
  mimeType?: string;
  bitrate?: number;
  width?: number;
  height?: number;
  /** Stringified bytes. */
  contentLength?: string;
  /** Frames per second when declared. */
  fps?: number;
}

/**
 * Extract ytInitialPlayerResponse from a single inline-script body.
 * YouTube embeds the blob as either `var ytInitialPlayerResponse = {...};`
 * or `window["ytInitialPlayerResponse"] = {...};`. Returns null when the
 * needle isn't in this body — caller iterates scripts until one matches.
 *
 * Exported so unit tests can verify the extraction against captured
 * script text without spinning up a DOM.
 */
export function parseYtPlayerResponseFromScript(scriptText: string): YtPlayerResponse | null {
  const needle = scriptText.indexOf('ytInitialPlayerResponse');
  if (needle < 0) return null;
  const braceAt = scriptText.indexOf('{', needle);
  if (braceAt < 0) return null;
  const json = extractJsonObject(scriptText, braceAt);
  if (!json) return null;
  try {
    return JSON.parse(json) as YtPlayerResponse;
  } catch {
    return null;
  }
}

/**
 * Walk inline `<script>` elements until one yields a parseable
 * ytInitialPlayerResponse. The content script runs in an isolated world
 * so `window.ytInitialPlayerResponse` from the page itself is not
 * visible — we scrape the script text instead. Returns null when the
 * blob is absent (embed pages without a player payload, network errors
 * mid-render, etc.); the adapter falls back to og:meta in that case.
 */
function parseYtPlayerResponse(doc: Document): YtPlayerResponse | null {
  const scripts = doc.querySelectorAll('script');
  for (const s of scripts) {
    const parsed = parseYtPlayerResponseFromScript(s.textContent ?? '');
    if (parsed) return parsed;
  }
  return null;
}

/**
 * Find the player `base.js` URL on the page. YouTube serves it from
 * `/s/player/<HASH>/player_ias.vflset/<LOCALE>/base.js` (sometimes
 * `player_ias_tce.vflset` on newer builds). The HASH rotates roughly
 * every few weeks; the offscreen n-param solver caches the compiled
 * function keyed by the URL so the solver rebuilds when YouTube
 * deploys a new player.
 *
 * Exported so tests can verify the regex against captured HTML
 * fixtures without spinning up a DOM.
 */
export function extractPlayerJsUrlFromScripts(doc: Document): string | null {
  const els = doc.querySelectorAll<HTMLScriptElement>('script[src*="base.js"]');
  for (const el of els) {
    const src = el.getAttribute('src');
    if (!src) continue;
    if (!/\/player\/[^/]+\/(?:player_ias[_a-z]*\.vflset)\/[^/]+\/base\.js/.test(src)) continue;
    // Resolve relative URLs against the document.
    try {
      return new URL(src, doc.baseURI).href;
    } catch {
      return src;
    }
  }
  return null;
}

// Bitrate fallback for older / minified `streamingData` payloads that
// drop `bitrate`. Keeps the size estimator from going to zero on streams
// that only carry width/height.
const DEFAULT_BITRATE = 0;

function mimeCodecs(mimeType: string | undefined): string | null {
  if (!mimeType) return null;
  const m = mimeType.match(/codecs=["']([^"']+)["']/);
  return m ? m[1] : null;
}

function isVideoFormat(mimeType: string | undefined): boolean {
  return !!mimeType && mimeType.startsWith('video/');
}

// Audio pairing is still limited to AAC/mp4a — that's what the future
// fMP4 two-track combine muxer (v0.11.1) will be able to handle without
// re-encoding. Opus-in-MP4 / Opus-in-WebM muxing is deferred. Adaptive
// VP9 / AV1 variants surface in the picker but get no paired audio, so
// the adaptive download attempt fails fast (UnsupportedFormatError)
// instead of silently producing a video-only file.
function isAacAudioMp4(mimeType: string | undefined): boolean {
  if (!mimeType) return false;
  return mimeType.startsWith('audio/mp4') && /\bmp4a\./i.test(mimeType);
}

function variantFromFormat(f: YtFormat, pairedAudio?: YtFormat): HlsVariant | null {
  // Skip protected formats. signatureCipher requires the n-param /
  // signature solver — v0.11.1+ work. Emitting these now would surface
  // unplayable URLs in the picker.
  if (!f.url) return null;
  // Accept any video mimeType (mp4 / webm / etc). Codec filtering used to
  // happen here for muxer compatibility, but modern YouTube serves
  // adaptive video mostly as VP9 / AV1 — pre-filtering on AVC made the
  // picker empty on the majority of current uploads. Codec compatibility
  // is enforced where it matters (the dispatch + future muxer) so users
  // see the full inventory.
  if (!isVideoFormat(f.mimeType)) return null;
  const resolution = f.width && f.height ? `${f.width}x${f.height}` : null;
  const v: HlsVariant = {
    url: f.url,
    bandwidth: f.bitrate ?? DEFAULT_BITRATE,
    resolution,
    codecs: mimeCodecs(f.mimeType),
    ...(f.contentLength ? { contentLength: Number(f.contentLength) } : {}),
  };
  if (pairedAudio?.url) {
    v.pairedAudioUrl = pairedAudio.url;
    if (pairedAudio.contentLength) {
      v.pairedAudioContentLength = Number(pairedAudio.contentLength);
    }
  }
  return v;
}

/**
 * Pick a single default audio rendition to pair with every adaptive
 * (video-only) variant. Highest-bitrate AAC/m4a wins because that's
 * what the v0.11 mux path expects; itag 140 is the universal anchor.
 * Returns undefined when no compatible audio is available — adaptive
 * variants then fall back to "video-only download" handling later.
 */
function pickDefaultAudioFormat(adaptiveFormats: YtFormat[]): YtFormat | undefined {
  const candidates = adaptiveFormats.filter((f) => f.url && isAacAudioMp4(f.mimeType));
  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
  return candidates[0];
}

/**
 * Turn a parsed ytInitialPlayerResponse into the DiscoveredStream
 * catalog the SW will promote to a MediaEntry. Returns an empty array
 * when the payload signals DRM / unplayable status, or when no usable
 * formats remain (all gated by signatureCipher in current YouTube
 * builds — fixed once v0.11.1's solver lands).
 *
 * Exported for unit tests.
 */
export function buildStreamsFromPlayerResponse(
  player: YtPlayerResponse | null,
  opts: { playerJsUrl?: string } = {},
): DiscoveredStream[] {
  if (!player) return [];

  const status = player.playabilityStatus?.status ?? 'OK';
  // Anything other than OK means the player couldn't initialize:
  // - LOGIN_REQUIRED / AGE_VERIFICATION_REQUIRED / CONTENT_CHECK_REQUIRED
  // - UNPLAYABLE (region-locked, members-only, premium-only)
  // - ERROR (deleted / privated)
  // None of these are downloadable through the public web stream path,
  // so emit nothing rather than show a broken row.
  if (status !== 'OK') return [];

  const progressiveFormats = player.streamingData?.formats ?? [];
  const adaptiveFormats = player.streamingData?.adaptiveFormats ?? [];
  const defaultAudio = pickDefaultAudioFormat(adaptiveFormats);

  // One-line diagnostic so the SW console reveals what YouTube served
  // for this video — formats with signatureCipher only (no direct
  // url) silently drop, and without this it's hard to tell whether
  // an empty result means "no usable URLs" or "filter rejected
  // everything". The log fires only when streamingData is present.
  const summarize = (f: YtFormat): string =>
    [
      `itag=${f.itag ?? '?'}`,
      f.url ? 'url' : f.signatureCipher ? 'sig' : 'no-url',
      f.mimeType?.split(';')[0] ?? 'no-mime',
    ].join(' ');
  log.info('youtube discoverStreams', {
    progressive: progressiveFormats.map(summarize),
    adaptive: adaptiveFormats.map(summarize),
    defaultAudio: defaultAudio ? summarize(defaultAudio) : null,
  });

  const variants: HlsVariant[] = [];
  // Progressive itags (18, 22, 36) carry audio + video in one file —
  // no pairing needed.
  for (const f of progressiveFormats) {
    const v = variantFromFormat(f);
    if (v) variants.push(v);
  }
  // Adaptive video formats need audio pairing.
  for (const f of adaptiveFormats) {
    const v = variantFromFormat(f, defaultAudio);
    if (v) variants.push(v);
  }
  if (variants.length === 0) return [];

  // Sort highest-quality first so the popup default (variants[0]) is
  // the best available — matches the HLS path.
  variants.sort((a, b) => b.bandwidth - a.bandwidth);

  const videoId = player.videoDetails?.videoId ?? '';
  const lengthSecs = Number(player.videoDetails?.lengthSeconds ?? '0');

  // The "identity URL" for the catalog. videoId is the natural key — a
  // synthetic scheme (`youtube:VID`) lets the SW dedupe per-tab on
  // re-discoveries without confusing the URL classifier (which only
  // cares about real http(s) URLs and would skip this anyway).
  const identityUrl = videoId ? `youtube:${videoId}` : variants[0].url;

  // Adaptive variants are the modern norm — mark the entry kind as
  // 'dash'. The download dispatch later inspects the chosen variant's
  // itag to pick the progressive-vs-adaptive path.
  return [
    {
      url: identityUrl,
      kind: 'dash',
      ...(lengthSecs > 0 ? { totalDuration: lengthSecs } : {}),
      variants,
      ...(opts.playerJsUrl ? { playerJsUrl: opts.playerJsUrl } : {}),
    },
  ];
}

function scrapeYouTubeMeta(doc: Document): PageMeta {
  const og = (prop: string): string | null =>
    doc.querySelector(`meta[property="${prop}"]`)?.getAttribute('content') ?? null;
  const ogTitle = og('og:title');
  const docTitle = doc.title ? stripYouTubeSuffix(doc.title) : '';

  // Prefer the player JSON when present — it carries the canonical
  // title, the channel/owner name, and the videoId without the
  // ambiguity of localized title suffixes.
  const player = parseYtPlayerResponse(doc);
  const videoDetails = player?.videoDetails ?? {};
  const microformat = player?.microformat?.playerMicroformatRenderer ?? {};

  const title = videoDetails.title || ogTitle || docTitle || '';
  const channelTitle = videoDetails.author || microformat.ownerChannelName || '';
  const videoId = videoDetails.videoId || '';

  return {
    title,
    ogTitle,
    ogVideoTitle: og('og:video:title'),
    ogDescription: og('og:description'),
    ogSiteName: og('og:site_name') ?? 'YouTube',
    ...(channelTitle ? { channelTitle } : {}),
    ...(videoId ? { videoId } : {}),
  };
}

const youtubeAdapter: Adapter = {
  id: 'youtube',
  matches(pageUrl) {
    return isYouTubePage(pageUrl);
  },
  scrapePageMeta: scrapeYouTubeMeta,
  observe(doc, onUpdate) {
    // YouTube is a single-page app: navigating watch → watch swaps the
    // <title> + meta tags but never reloads the document. The default
    // adapter's title-watcher pattern works here too.
    if (typeof MutationObserver === 'undefined') return () => {};
    const head = doc.head || doc.documentElement;
    if (!head) return () => {};
    let last = doc.title || '';
    const observer = new MutationObserver(() => {
      const t = doc.title || '';
      if (t === last) return;
      last = t;
      onUpdate(scrapeYouTubeMeta(doc));
    });
    observer.observe(head, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  },
  discoverStreams(doc) {
    const player = parseYtPlayerResponse(doc);
    const playerJsUrl = extractPlayerJsUrlFromScripts(doc) ?? undefined;
    return buildStreamsFromPlayerResponse(player, { playerJsUrl });
  },
  deriveFilename({ pageMeta }) {
    const title = pageMeta?.title || pageMeta?.ogTitle || '';
    const channel = pageMeta?.channelTitle || '';
    // Prefix with the channel so files from the same creator group
    // lexicographically in the user's downloads folder. Skip the prefix
    // when channel is missing rather than emitting a leading " - ".
    const raw = channel && title ? `${channel} - ${title}` : title;
    return sanitizeFilename(raw, { fallback: 'youtube-video' });
  },
};

export default youtubeAdapter;
