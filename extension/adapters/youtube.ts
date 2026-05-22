import { log } from '../lib/log.js';
import { sanitizeFilename } from '../lib/sanitize-filename.js';
import type { Adapter, DiscoveredStream, HlsVariant, PageMeta } from '../lib/types.ts';
import {
  INNERTUBE_CLIENTS,
  buildInnerTubePlayerBody,
  type InnerTubeClient,
} from './youtube-clients.js';
import { computeSapisidhash, extractVisitorData } from './youtube-auth.js';

// Per-videoId cache for the InnerTube response. SPA navigation in
// page-content.ts fires discoverStreams on every title change, which
// for YouTube usually means a new video — so the cache mostly serves
// to deduplicate double-fires within the same video and survive the
// initial-scrape + observe-fires-once pair.
//
// Type-quirky on purpose: the value is a Promise so concurrent callers
// share one in-flight request rather than racing.
const innerTubeCache = new Map<string, Promise<YtPlayerResponse | null>>();

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
 * (video-only) variant. Highest-bitrate AAC/m4a wins because that's
 * what the v0.11 mux path expects; itag 140 is the universal anchor.
 * Returns undefined when no compatible audio is available — adaptive
 * variants then fall back to "video-only download" handling later.
 */
function pickDefaultAudioFormat(adaptiveFormats: YtFormat[]): YtFormat | undefined {
  // Either a direct url or a cipher (signatureCipher / legacy cipher —
  // 1080p+ era YouTube serves audio gated too) is acceptable.
  // urlAndCipherFromFormat pulls the working URL out of either shape;
  // the downloader applies the signature transform when one is set.
  const candidates = adaptiveFormats.filter(
    (f) => (f.url || f.signatureCipher || f.cipher) && isAacAudioMp4(f.mimeType),
  );
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
  log.info('youtube discoverStreams', {
    source,
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
  const body = buildInnerTubePlayerBody(videoId, client) as {
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
  log.info('youtube discoverYouTubeStreams: enter');

  const inlinePlayer = parseYtPlayerResponse(doc);
  const inlineStreams = buildStreamsFromPlayerResponse(inlinePlayer, 'inline');
  if (hasAdaptiveStream(inlineStreams)) {
    log.info('youtube discoverYouTubeStreams: inline has adaptive — using it');
    return inlineStreams;
  }

  const videoId = inlinePlayer?.videoDetails?.videoId;
  if (!videoId) {
    // Embed pages, malformed responses — nothing to fetch with. Return
    // whatever the inline scrape gave us (often just progressive).
    log.warn('youtube discoverYouTubeStreams: no videoId — skipping InnerTube', {
      hasPlayer: !!inlinePlayer,
      hasVideoDetails: !!inlinePlayer?.videoDetails,
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
    extractVisitorData(inlinePlayer) ?? readVisitorDataFromYtInitialData(doc) ?? undefined;
  const sapisidhash = (await computeSapisidhash().catch(() => null)) ?? undefined;
  log.info('youtube discoverYouTubeStreams: starting InnerTube ladder', {
    videoId,
    hasVisitorData: !!visitorData,
    hasSapisidhash: !!sapisidhash,
  });
  let cached = innerTubeCache.get(videoId);
  if (!cached) {
    cached = runInnerTubeLadder(videoId, { sapisidhash, visitorData });
    innerTubeCache.set(videoId, cached);
  }
  let itPlayer: YtPlayerResponse | null;
  try {
    itPlayer = await cached;
  } catch (err) {
    // runInnerTubeLadder catches per-client failures internally, so a
    // throw here would be unexpected. Log and fall back to inline.
    log.warn('youtube discoverYouTubeStreams: ladder threw', {
      err: err instanceof Error ? err.message : String(err),
    });
    innerTubeCache.delete(videoId);
    return inlineStreams;
  }
  if (!itPlayer) {
    log.warn('youtube discoverStreams: all InnerTube clients failed; using inline', {
      videoId,
    });
    return inlineStreams;
  }
  const itStreams = buildStreamsFromPlayerResponse(itPlayer, 'innertube');
  if (itStreams.length === 0) return inlineStreams;
  return itStreams;
}

async function runInnerTubeLadder(
  videoId: string,
  auth: InnerTubeAuth,
): Promise<YtPlayerResponse | null> {
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
      return player;
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
