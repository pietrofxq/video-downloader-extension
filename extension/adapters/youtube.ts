import { log } from '../lib/log.js';
import { sanitizeFilename } from '../lib/sanitize-filename.js';
import type { Adapter, AudioTrack, DiscoveredStream, HlsVariant, PageMeta } from '../lib/types.ts';
import {
  INNERTUBE_CLIENTS,
  buildInnerTubePlayerBody,
  type InnerTubeClient,
} from './youtube-clients.js';
import { computeSapisidhash, extractVisitorData } from './youtube-auth.js';
import { acquirePoToken } from './youtube-potoken.js';

// Per-videoId cache for the InnerTube response. SPA navigation in
// page-content.ts fires discoverStreams on every title change, which
// for YouTube usually means a new video — so the cache mostly serves
// to deduplicate double-fires within the same video and survive the
// initial-scrape + observe-fires-once pair.
//
// Type-quirky on purpose: the value is a Promise so concurrent callers
// share one in-flight request rather than racing.
const innerTubeCache = new Map<string, Promise<LadderResult | null>>();

/** Test hook — drop the per-videoId InnerTube cache between cases. */
export function _clearInnerTubeCacheForTests(): void {
  innerTubeCache.clear();
}

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

/**
 * The URL's videoId is authoritative on SPA navigation. The inline
 * `ytInitialPlayerResponse` script tag is written once at full page
 * load and YouTube does NOT rewrite it when the user clicks through
 * to another video — fresh player data arrives via XHR to
 * `/youtubei/v1/player` and the player UI hydrates from that. So a
 * caller who reads `parseYtPlayerResponse(doc).videoDetails.videoId`
 * on a watch page that's been SPA-navigated will see the ORIGINAL
 * video's id, not the current one. That was the v0.11.6 field
 * report ("popup keeps showing the previous video after navigation
 * — only refresh fixes it"). The URL stays in sync via
 * history.pushState, so use it as the source of truth.
 *
 * Returns null when the URL doesn't carry a recoverable id (channel
 * pages, home page, etc. — `isYouTubePage` would've rejected those
 * upstream but we defend anyway).
 *
 * Exported for unit tests.
 */
export function extractVideoIdFromUrl(pageUrl: string): string | null {
  try {
    const u = new URL(pageUrl);
    const host = u.hostname;
    if (host === 'youtu.be') {
      const seg = u.pathname.slice(1).split('/')[0];
      return seg || null;
    }
    if (u.pathname === '/watch') {
      return u.searchParams.get('v');
    }
    for (const prefix of ['/shorts/', '/embed/', '/live/']) {
      if (u.pathname.startsWith(prefix)) {
        const seg = u.pathname.slice(prefix.length).split('/')[0];
        return seg || null;
      }
    }
  } catch {
    // fall through
  }
  return null;
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
  /** Per-session anti-bot fingerprint. Carried into every InnerTube
   *  call as `context.client.visitorData` + `X-Goog-Visitor-Id`. */
  responseContext?: {
    visitorData?: string;
  };
}

interface YtFormat {
  itag?: number;
  url?: string;
  /** Newer YouTube serves the URL as `s` (sig) + `sp` (sigParam) inside
   * this percent-encoded query string. v0.11.1's downloader re-deciphers
   * the signature before fetch. */
  signatureCipher?: string;
  /** Legacy YouTube field name — same shape as `signatureCipher`. Some
   * responses still serve it under this key (notably some YouTube Music
   * and older client contexts). Read both so we don't drop variants. */
  cipher?: string;
  mimeType?: string;
  bitrate?: number;
  width?: number;
  height?: number;
  /** Stringified bytes. */
  contentLength?: string;
  /** Frames per second when declared. */
  fps?: number;
  /**
   * Per-track metadata when the video ships multiple audio renditions
   * (dubs). YouTube returns ALL tracks' AAC/Opus formats inside
   * `adaptiveFormats[]`, each tagged with this object. Absent on
   * single-track videos.
   *
   * `audioIsDefault` is the load-bearing flag — the canonical
   * "original" track for the video is marked true on its formats and
   * is what the player picks unless the user overrides. Without
   * checking this, picking the highest-bitrate AAC across the array
   * picks an arbitrary dub.
   */
  audioTrack?: {
    id?: string;
    displayName?: string;
    audioIsDefault?: boolean;
  };
}

/**
 * Walk inline `<script>` elements until one yields a parseable object
 * literal anchored on the given variable name. The walker is the same
 * for both `ytInitialPlayerResponse` (player blob) and `ytInitialData`
 * (page state blob) — only the needle changes.
 */
function parseInlineBlob(doc: Document, needleName: string): unknown {
  const scripts = doc.querySelectorAll('script');
  for (const s of scripts) {
    const text = s.textContent ?? '';
    const needle = text.indexOf(needleName);
    if (needle < 0) continue;
    const braceAt = text.indexOf('{', needle);
    if (braceAt < 0) continue;
    const json = extractJsonObject(text, braceAt);
    if (!json) continue;
    try {
      return JSON.parse(json);
    } catch {
      // try the next script
    }
  }
  return null;
}

/**
 * Read `responseContext.visitorData` out of YouTube's `ytInitialData`
 * blob — the page-state JSON that ships separately from the player
 * response. visitorData lives here on every modern watch page; the
 * player response often elides it. Falls back to null when both
 * blobs miss it.
 */
function readVisitorDataFromYtInitialData(doc: Document): string | null {
  const init = parseInlineBlob(doc, 'ytInitialData') as {
    responseContext?: { visitorData?: string };
  } | null;
  return init?.responseContext?.visitorData ?? null;
}

/**
 * Read `VISITOR_DATA` out of the page's `ytcfg.set({...})` bootstrap
 * script — the source YouTube's own JS uses.
 *
 * This is the reliable location on current watch pages. A v0.12 field
 * capture showed the value absent from BOTH the player response and
 * `ytInitialData` while the page carried it in `ytcfg` all along, so
 * the InnerTube ladder had been running with no visitor fingerprint at
 * all (`hasVisitorData: false` in the log).
 *
 * The content script runs in an isolated world and cannot read
 * `window.ytcfg`, so the literal is scraped out of the script text —
 * same approach as the other inline-blob readers here.
 *
 * Exported for unit tests.
 */
export function readVisitorDataFromYtcfg(doc: Document): string | null {
  for (const s of doc.querySelectorAll('script')) {
    const m = /"VISITOR_DATA"\s*:\s*"([^"]+)"/.exec(s.textContent ?? '');
    if (m?.[1]) return m[1];
  }
  return null;
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

/**
 * Extract a fetchable URL from a YouTube format. Modern YouTube serves
 * higher-quality formats only as `signatureCipher=url=...&s=...&sp=...`
 * — the `url` param inside is what the player would point at, but the
 * `s` value still needs deciphering by yt-sig before the CDN will serve
 * the bytes. We return the decoded url= so the picker has something
 * concrete to show (resolution / size); the cipher blob travels
 * alongside on `variant.signatureCipher` for the downloader to actually
 * apply the signature transform at fetch time.
 *
 * Exported for unit tests so the cipher-admittance behavior can be
 * exercised without spinning up a YtPlayerResponse fixture.
 */
export function urlAndCipherFromFormat(f: YtFormat): {
  url: string | null;
  signatureCipher: string | null;
} {
  if (f.url) return { url: f.url, signatureCipher: null };
  // Read both the modern (`signatureCipher`) and legacy (`cipher`) field
  // names — YouTube has historically used either depending on the
  // client context and ytInitialPlayerResponse build.
  const cipher = f.signatureCipher ?? f.cipher;
  if (!cipher) return { url: null, signatureCipher: null };
  try {
    const params = new URLSearchParams(cipher);
    const u = params.get('url');
    if (!u) return { url: null, signatureCipher: null };
    return { url: u, signatureCipher: cipher };
  } catch {
    return { url: null, signatureCipher: null };
  }
}

function variantFromFormat(f: YtFormat, pairedAudio?: YtFormat): HlsVariant | null {
  // Accept any video mimeType (mp4 / webm / etc). Codec filtering used to
  // happen here for muxer compatibility, but modern YouTube serves
  // adaptive video mostly as VP9 / AV1 — pre-filtering on AVC made the
  // picker empty on the majority of current uploads. Codec compatibility
  // is enforced where it matters (the dispatch + future muxer) so users
  // see the full inventory.
  if (!isVideoFormat(f.mimeType)) return null;
  const { url, signatureCipher } = urlAndCipherFromFormat(f);
  if (!url) return null;
  const resolution = f.width && f.height ? `${f.width}x${f.height}` : null;
  const v: HlsVariant = {
    url,
    bandwidth: f.bitrate ?? DEFAULT_BITRATE,
    ...(typeof f.itag === 'number' ? { itag: f.itag } : {}),
    resolution,
    codecs: mimeCodecs(f.mimeType),
    ...(f.contentLength ? { contentLength: Number(f.contentLength) } : {}),
    ...(signatureCipher ? { signatureCipher } : {}),
  };
  if (pairedAudio) {
    const a = urlAndCipherFromFormat(pairedAudio);
    if (a.url) {
      v.pairedAudioUrl = a.url;
      if (pairedAudio.contentLength) {
        v.pairedAudioContentLength = Number(pairedAudio.contentLength);
      }
      if (a.signatureCipher) {
        v.pairedSignatureCipher = a.signatureCipher;
      }
    }
  }
  return v;
}

/**
 * Pick a single default audio rendition to pair with every adaptive
 * (video-only) variant.
 *
 * Multi-dub videos (e.g. official channels with French/Spanish/German
 * tracks) ship ALL tracks' AAC formats in `adaptiveFormats[]`, each
 * tagged with an `audioTrack` object whose `audioIsDefault: true`
 * marks the canonical original track. Picking purely by bitrate would
 * grab whichever dub happened to win the bitrate tiebreak — that's
 * how a French dub ended up paired with an English-original video in
 * the field. Filter to `audioIsDefault === true` first; fall back to
 * "any AAC" only when no track is marked default (single-track videos
 * and older payloads that elided the field).
 *
 * Returns undefined when no compatible audio is available — adaptive
 * variants then fall back to "video-only download" handling later.
 */
function pickDefaultAudioFormat(adaptiveFormats: YtFormat[]): YtFormat | undefined {
  const isAacWithUrl = (f: YtFormat): boolean =>
    !!(f.url || f.signatureCipher || f.cipher) && isAacAudioMp4(f.mimeType);

  // Pass 1: tracks explicitly marked default.
  const defaults = adaptiveFormats.filter((f) => isAacWithUrl(f) && f.audioTrack?.audioIsDefault);
  if (defaults.length > 0) {
    defaults.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
    return defaults[0];
  }
  // Pass 2: any AAC — covers single-track videos (`audioTrack`
  // entirely absent) and older response shapes.
  const fallback = adaptiveFormats.filter(isAacWithUrl);
  if (fallback.length === 0) return undefined;
  fallback.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
  return fallback[0];
}

/**
 * Group `adaptiveFormats[]` AAC entries by `audioTrack.id` and emit
 * one `AudioTrack` per distinct track. Each emitted track points at
 * the highest-bitrate AAC format for that group — the user picks
 * a track in the popup and the SW substitutes the underlying URL
 * for the variant's default `pairedAudioUrl` at download time.
 *
 * Returns undefined when the video has zero or one distinct track —
 * the popup hides the picker in that case and the existing
 * `variant.pairedAudioUrl` plumbing covers it.
 *
 * Exported for unit tests.
 */
export function buildAudioTracks(adaptiveFormats: YtFormat[]): AudioTrack[] | undefined {
  const byId = new Map<string, YtFormat[]>();
  for (const f of adaptiveFormats) {
    if (!isAacAudioMp4(f.mimeType)) continue;
    if (!f.url && !f.signatureCipher && !f.cipher) continue;
    const id = f.audioTrack?.id;
    if (!id) continue; // single-track videos elide audioTrack entirely
    const group = byId.get(id);
    if (group) group.push(f);
    else byId.set(id, [f]);
  }
  if (byId.size < 2) return undefined; // hide the picker for single-track or no-track payloads

  const tracks: AudioTrack[] = [];
  for (const [id, formats] of byId) {
    formats.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
    const best = formats[0];
    const { url, signatureCipher } = urlAndCipherFromFormat(best);
    if (!url) continue;
    const at = best.audioTrack ?? {};
    tracks.push({
      id,
      displayName: at.displayName || id,
      isDefault: at.audioIsDefault === true,
      url,
      ...(best.contentLength ? { contentLength: Number(best.contentLength) } : {}),
      ...(signatureCipher ? { signatureCipher } : {}),
    });
  }
  // Default track first, then the rest. Within each group preserve
  // insertion order so the listing stays stable across discoveries.
  tracks.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  return tracks.length > 0 ? tracks : undefined;
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
  source: string = 'inline',
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
  // for this video — formats with cipher gating but no direct url
  // would silently drop pre-v0.11.1; without this it's hard to tell
  // whether an empty result means "no usable URLs" or "filter rejected
  // everything". The log fires only when streamingData is present.
  //
  // When a format reports "no-url" we also dump its raw key set so a
  // future YouTube response with a field-name we don't recognize is
  // visible at first sight instead of leading to a debug round-trip.
  const summarize = (f: YtFormat): string => {
    let urlState: string;
    if (f.url) urlState = 'url';
    else if (f.signatureCipher) urlState = 'sig';
    else if (f.cipher) urlState = 'cipher';
    else urlState = `no-url(keys=${Object.keys(f).join(',')})`;
    return [`itag=${f.itag ?? '?'}`, urlState, f.mimeType?.split(';')[0] ?? 'no-mime'].join(' ');
  };
  const audioTracks = buildAudioTracks(adaptiveFormats);
  log.info('youtube discoverStreams', {
    source,
    progressive: progressiveFormats.map(summarize),
    adaptive: adaptiveFormats.map(summarize),
    defaultAudio: defaultAudio ? summarize(defaultAudio) : null,
    audioTracks: audioTracks?.map((t) => `${t.id}${t.isDefault ? '*' : ''}:${t.displayName}`),
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
      ...(audioTracks ? { audioTracks } : {}),
      discoverySource: source,
    },
  ];
}

function scrapeYouTubeMeta(doc: Document): PageMeta {
  const og = (prop: string): string | null =>
    doc.querySelector(`meta[property="${prop}"]`)?.getAttribute('content') ?? null;
  const ogTitle = og('og:title');
  const docTitle = doc.title ? stripYouTubeSuffix(doc.title) : '';

  // URL is authoritative on SPA-nav (see extractVideoIdFromUrl). The
  // inline player blob is read for the title / channel fallback when
  // its videoId matches the URL — otherwise it's stale and we fall
  // back to DOM signals (which DO update on SPA-nav).
  const pageUrl = (typeof doc?.location?.href === 'string' && doc.location.href) || '';
  const urlVideoId = extractVideoIdFromUrl(pageUrl);
  const player = parseYtPlayerResponse(doc);
  const inlineVideoId = player?.videoDetails?.videoId ?? null;
  const inlineUsable = !urlVideoId || !inlineVideoId || urlVideoId === inlineVideoId;
  const videoDetails = inlineUsable ? (player?.videoDetails ?? {}) : {};
  const microformat = inlineUsable ? (player?.microformat?.playerMicroformatRenderer ?? {}) : {};

  // Title fallback order matters on SPA-nav. When inline is stale,
  // the title MutationObserver in `observe` fires *because*
  // doc.title changed — so doc.title is the freshest signal at that
  // moment. og:title meta updates a few hundred ms later (YouTube's
  // ordering, not ours), so a fresh scrape during that window sees
  // a still-old og:title alongside the already-new doc.title. The
  // field report was: "video updates but the title is still the
  // old one" — that's exactly the og-before-doctitle fallback
  // returning the stale value.
  //
  // When inline IS usable, videoDetails.title is canonical (no
  // localized " - YouTube" suffix, no stripping needed).
  const title = inlineUsable
    ? videoDetails.title || ogTitle || docTitle || ''
    : docTitle || ogTitle || '';
  const channelTitle = videoDetails.author || microformat.ownerChannelName || '';
  log.debug('youtube scrapeYouTubeMeta', {
    urlVideoId,
    inlineVideoId,
    inlineUsable,
    docTitle,
    ogTitle,
    videoDetailsTitle: videoDetails.title,
    chosenTitle: title,
  });
  // Prefer the URL's videoId — it's the one the user actually
  // navigated to. Falls back to the inline blob's id when the URL
  // doesn't expose one (some embed paths).
  const videoId = urlVideoId || videoDetails.videoId || '';

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

/**
 * Does any DiscoveredStream surface a variant we'd actually want to
 * download for adaptive (HD) playback? "Has paired audio" is a stand-in
 * for "this is an adaptive video variant with an audio sibling" — only
 * adaptive variants ever set `pairedAudioUrl` in buildStreamsFromPlayerResponse.
 *
 * Used to decide whether the inline `ytInitialPlayerResponse` was rich
 * enough or whether we should fall through to an InnerTube fetch.
 */
function hasAdaptiveStream(streams: DiscoveredStream[]): boolean {
  return streams.some(
    (s) => Array.isArray(s.variants) && s.variants.some((v) => !!v.pairedAudioUrl),
  );
}

/**
 * Do two variants describe the same rendition? `itag` is authoritative
 * when both sides carry it; resolution + codecs is the fallback for
 * payloads that elided it.
 */
function sameRendition(a: HlsVariant, b: HlsVariant): boolean {
  if (typeof a.itag === 'number' && typeof b.itag === 'number') return a.itag === b.itag;
  return a.resolution === b.resolution && a.codecs === b.codecs;
}

/**
 * Fold the inline (WEB-session) catalog into the InnerTube one,
 * preferring inline on collisions.
 *
 * Field-verified in v0.12: googlevideo serves URLs minted for the
 * page's own WEB session with no poToken (the n-transform alone is
 * enough) and refuses the ones our InnerTube calls return. Under SABR
 * the inline response carries no adaptive URLs, but its progressive
 * format IS fetchable — so replacing the inline catalog wholesale with
 * InnerTube's, which is what we used to do, threw away the only
 * working URL on the page and left the video entirely undownloadable.
 *
 * Inline wins collisions precisely because it is the fetchable side.
 * The InnerTube-only entries (every adaptive quality, including 4K)
 * are kept — they stay gated until Phase B lands, but they carry the
 * real format inventory and the popup should keep showing it.
 *
 * Exported for unit tests.
 */
export function mergeInlineIntoInnerTube(
  itStreams: DiscoveredStream[],
  inlineStreams: DiscoveredStream[],
): DiscoveredStream[] {
  const inlineVariants = inlineStreams[0]?.variants ?? [];
  const target = itStreams[0];
  if (inlineVariants.length === 0 || !target) return itStreams;

  const merged = [...(target.variants ?? [])];
  let replaced = 0;
  for (const v of inlineVariants) {
    const at = merged.findIndex((m) => sameRendition(m, v));
    if (at >= 0) {
      merged[at] = v;
      replaced += 1;
    } else {
      merged.push(v);
    }
  }
  merged.sort((a, b) => b.bandwidth - a.bandwidth);
  log.info('youtube: merged inline WEB variants into the InnerTube catalog', {
    inlineVariants: inlineVariants.length,
    replaced,
    added: inlineVariants.length - replaced,
    total: merged.length,
  });
  return [{ ...target, variants: merged }, ...itStreams.slice(1)];
}

/**
 * Auth + session context for an InnerTube call. Both fields are
 * optional — when present, they lift the bot-check gates that fire
 * on anonymous requests to non-WEB clients.
 *
 *  - `sapisidhash`: an `Authorization: SAPISIDHASH ...` header value.
 *    Computed from the user's SAPISID cookie + the InnerTube origin.
 *    Proves the caller has the signed-in account's auth cookies.
 *    When set, also sets `X-Origin: https://www.youtube.com`.
 *  - `visitorData`: per-session anti-bot fingerprint from the inline
 *    `ytInitialPlayerResponse.responseContext.visitorData`. Carried
 *    in both `context.client.visitorData` and `X-Goog-Visitor-Id`.
 */
export interface InnerTubeAuth {
  sapisidhash?: string;
  visitorData?: string;
  /**
   * BotGuard-derived proof-of-origin token (Phase B). When present it
   * rides in the request body's `serviceIntegrityDimensions`, which is
   * what makes the returned media URLs fetchable — see the comment in
   * `buildInnerTubePlayerBody`. Absent means the pre-v0.12 behavior:
   * the call still issues, and its URLs come back gated.
   */
  poToken?: string;
}

/**
 * Hit the InnerTube `/youtubei/v1/player` endpoint with the given
 * client context and return the parsed response. Returns null on any
 * failure (network, non-200, JSON parse) so the caller can fall
 * through to the next client cleanly.
 *
 * Must be called from the content-script context — the request's
 * Origin / Referer have to be `https://www.youtube.com` for the
 * InnerTube endpoint to accept it, and only the watch-page content
 * script naturally carries that origin (offscreen / SW would 403).
 *
 * When the optional `auth` argument carries a SAPISIDHASH and/or
 * visitorData, the request gets the auth + session headers YouTube's
 * own JS sends. Without them, every non-WEB client falls into the
 * "Sign in to confirm you're not a bot" gate even for signed-in
 * accounts. See youtube-auth.ts.
 *
 * Exported so unit tests can mock `fetch` and assert the request shape.
 */
export async function fetchInnerTubePlayer(
  videoId: string,
  client: InnerTubeClient,
  auth: InnerTubeAuth = {},
): Promise<YtPlayerResponse | null> {
  const url = `https://www.youtube.com/youtubei/v1/player?key=${client.apiKey}`;
  // Mirror the visitorData into the request body's context.client so
  // both call shapes carry it. YouTube's own JS does this — the
  // server checks both places and the body is the more reliable
  // signal for some client variants.
  const body = buildInnerTubePlayerBody(videoId, client, auth.poToken) as {
    context: { client: Record<string, unknown> };
  } & Record<string, unknown>;
  if (auth.visitorData) {
    body.context.client.visitorData = auth.visitorData;
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    // Mark the request as an InnerTube call. YouTube uses these on
    // the server side to route to the right client handler — they
    // matter more than the User-Agent for non-mobile clients. We
    // can't set User-Agent from a content-script fetch anyway
    // (Chrome treats UA as a forbidden header), so the client name
    // we send here IS the signal.
    'X-YouTube-Client-Name': client.context.clientName ?? '',
    'X-YouTube-Client-Version': client.context.clientVersion ?? '',
  };
  if (auth.sapisidhash) {
    // SAPISIDHASH + X-Origin pair is the canonical YouTube auth
    // proof. X-Origin matters because some YouTube auth paths
    // double-check it against the cookies' allowed origins.
    headers['Authorization'] = auth.sapisidhash;
    headers['X-Origin'] = 'https://www.youtube.com';
  }
  if (auth.visitorData) {
    headers['X-Goog-Visitor-Id'] = auth.visitorData;
  }
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify(body),
    });
  } catch (err) {
    log.warn(`youtube innertube ${client.name} fetch threw`, {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  if (!response.ok) {
    log.warn(`youtube innertube ${client.name} non-200`, { status: response.status });
    return null;
  }
  try {
    return (await response.json()) as YtPlayerResponse;
  } catch (err) {
    log.warn(`youtube innertube ${client.name} json parse failed`, {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Run the full discovery ladder for a YouTube watch page:
 *  1. Parse inline `ytInitialPlayerResponse` (cheap, always available).
 *     If it carries adaptive streams (rare on current WEB-client
 *     YouTube — SABR strips URLs), use it.
 *  2. Otherwise fetch from InnerTube using each client in the table,
 *     stopping at the first response that lights up adaptive variants.
 *  3. Fall back to inline if every InnerTube client failed — at least
 *     the progressive 360p will still surface.
 *
 * Cached per videoId because page-content fires this on both initial
 * scrape and every `observe` MutationObserver hit; without a cache, a
 * single navigation can fire it twice in quick succession.
 *
 * Exported so unit tests can drive the ladder against mocked fetch.
 */
export async function discoverYouTubeStreams(doc: Document): Promise<DiscoveredStream[]> {
  // Entry diagnostic — fires on every discoverStreams call so the SW
  // log shows whether the function even ran. If this line is missing,
  // the issue is upstream (page-content didn't dispatch / adapter
  // mismatch / build didn't include the new code).
  const pageUrl = (typeof doc?.location?.href === 'string' && doc.location.href) || '';
  const urlVideoId = extractVideoIdFromUrl(pageUrl);
  log.info('youtube discoverYouTubeStreams: enter', {
    pageUrl,
    urlVideoId,
  });

  const inlinePlayer = parseYtPlayerResponse(doc);
  const inlineVideoId = inlinePlayer?.videoDetails?.videoId ?? null;
  // SPA-nav staleness: the inline ytInitialPlayerResponse blob is
  // bolted to the page at full load and YouTube doesn't rewrite it
  // when the user clicks through. So on a SPA-navigated watch page,
  // inline carries the ORIGINAL videoId and url-derived id is the
  // current one. When they disagree, the inline data is unusable —
  // skip it and force the InnerTube ladder against the URL's id.
  const inlineStale = !!urlVideoId && !!inlineVideoId && urlVideoId !== inlineVideoId;
  if (inlineStale) {
    log.info('youtube discoverYouTubeStreams: inline blob is stale (SPA-nav)', {
      urlVideoId,
      inlineVideoId,
    });
  }

  const inlineStreams = inlineStale ? [] : buildStreamsFromPlayerResponse(inlinePlayer, 'inline');
  if (!inlineStale && hasAdaptiveStream(inlineStreams)) {
    log.info('youtube discoverYouTubeStreams: inline has adaptive — using it', {
      urlVideoId,
      inlineVideoId,
    });
    return inlineStreams;
  }

  // Resolution order for the InnerTube videoId: URL > inline. The
  // URL is authoritative on SPA-nav; inline is a fallback for cases
  // where the URL is opaque (some embed paths).
  const videoId = urlVideoId ?? inlineVideoId;
  if (!videoId) {
    // Embed pages, malformed responses — nothing to fetch with. Return
    // whatever the inline scrape gave us (often just progressive).
    log.warn('youtube discoverYouTubeStreams: no videoId — skipping InnerTube', {
      hasPlayer: !!inlinePlayer,
      hasVideoDetails: !!inlinePlayer?.videoDetails,
      urlVideoId,
      inlineVideoId,
    });
    return inlineStreams;
  }

  // Pull session/auth context off the inline scrape so the InnerTube
  // ladder can present itself as the signed-in user with the same
  // visitor fingerprint YouTube's own JS uses. Both are best-effort —
  // null values just mean some clients will still hit bot gates.
  //
  // visitorData usually lives in `ytInitialData`, not the player
  // response — we check both blobs so the value lands either way.
  const visitorData =
    extractVisitorData(inlinePlayer) ??
    readVisitorDataFromYtInitialData(doc) ??
    readVisitorDataFromYtcfg(doc) ??
    undefined;
  const sapisidhash = (await computeSapisidhash().catch(() => null)) ?? undefined;
  // Phase B seam. Null today, which is exactly the pre-v0.12 path: the
  // ladder runs unattested and its URLs come back gated. Prefer a
  // session binding when visitorData is available, else content.
  const poToken =
    (await acquirePoToken({
      binding: visitorData ? { kind: 'session', visitorData } : { kind: 'content', videoId },
      doc,
    }).catch(() => null)) ?? undefined;
  log.info('youtube discoverYouTubeStreams: starting InnerTube ladder', {
    videoId,
    hasVisitorData: !!visitorData,
    hasSapisidhash: !!sapisidhash,
    hasPoToken: !!poToken,
  });
  // Attestation state is part of the key: once Phase B starts returning
  // tokens, an entry cached from an earlier unattested run would
  // otherwise keep serving gated URLs for the rest of the session.
  const cacheKey = `${videoId}:${poToken ? 'attested' : 'unattested'}`;
  let cached = innerTubeCache.get(cacheKey);
  if (!cached) {
    cached = runInnerTubeLadder(videoId, { sapisidhash, visitorData, poToken });
    innerTubeCache.set(cacheKey, cached);
  }
  let ladder: LadderResult | null;
  try {
    ladder = await cached;
  } catch (err) {
    // runInnerTubeLadder catches per-client failures internally, so a
    // throw here would be unexpected. Log and fall back to inline.
    log.warn('youtube discoverYouTubeStreams: ladder threw', {
      err: err instanceof Error ? err.message : String(err),
    });
    innerTubeCache.delete(cacheKey);
    return inlineStreams;
  }
  if (!ladder) {
    log.warn('youtube discoverStreams: all InnerTube clients failed; using inline', {
      videoId,
    });
    return inlineStreams;
  }
  const itStreams = buildStreamsFromPlayerResponse(ladder.player, `innertube:${ladder.clientName}`);
  if (itStreams.length === 0) return inlineStreams;
  return mergeInlineIntoInnerTube(itStreams, inlineStreams);
}

/** Winning client's response plus its name, so a URL that later 403s
 *  can be traced back to the client that minted it. */
interface LadderResult {
  player: YtPlayerResponse;
  clientName: string;
}

async function runInnerTubeLadder(
  videoId: string,
  auth: InnerTubeAuth,
): Promise<LadderResult | null> {
  for (const client of INNERTUBE_CLIENTS) {
    const player = await fetchInnerTubePlayer(videoId, client, auth);
    if (!player) continue;
    // Surface the playabilityStatus per-client so a non-OK response
    // (LOGIN_REQUIRED / UNPLAYABLE / CONTENT_CHECK_REQUIRED / …) is
    // visible in the log even though buildStreamsFromPlayerResponse
    // returns [] without firing its own log in that case.
    const status = player.playabilityStatus?.status ?? 'OK';
    if (status !== 'OK') {
      log.warn(`youtube innertube ${client.name} non-OK playabilityStatus`, {
        status,
        reason: player.playabilityStatus?.reason,
      });
      continue;
    }
    // Quick acceptance check: did this client return any adaptive
    // format with a URL or cipher? If not, move on — the next client
    // might do better.
    const streams = buildStreamsFromPlayerResponse(player, `probe:${client.name}`);
    if (hasAdaptiveStream(streams)) {
      log.info(`youtube discoverStreams: client=${client.name} succeeded`);
      return { player, clientName: client.name };
    }
    log.warn(`youtube innertube ${client.name} returned OK but no adaptive variants`);
  }
  return null;
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
      // Diagnostic — fires only when the title actually changed. Useful
      // for spotting "popup title didn't update" reports: if this log
      // appears with the new title, the observer is firing and the
      // re-scrape happens; downstream must be the problem (see
      // setAdapterMeta back-patch). If the log doesn't appear at all,
      // YouTube isn't triggering a MutationObserver-visible change for
      // this transition and we'd need a different signal.
      log.info('youtube observe: title changed', { prev: last, next: t });
      last = t;
      onUpdate(scrapeYouTubeMeta(doc));
    });
    observer.observe(head, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  },
  discoverStreams(doc) {
    return discoverYouTubeStreams(doc);
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
