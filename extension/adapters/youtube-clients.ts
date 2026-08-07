// InnerTube client table for the YouTube adapter (v0.11.2).
//
// YouTube's WEB-client `ytInitialPlayerResponse.streamingData` has been
// migrated to SABR — adaptiveFormats[] ships metadata without per-format
// URLs. Other InnerTube clients still return adaptiveFormats[] with
// `url` or `signatureCipher` in many contexts, which is exactly what
// v0.11.1's pipeline consumes.
//
// Which client currently works is volatile — YouTube tightens client
// contexts in waves. The list below mirrors LuanRT/YouTube.js's
// currently-working set as a starting point; rotating it should be a
// data change here, not a code change in the call sites.
//
// IMPORTANT — Chrome's content-script `fetch()` cannot set
// `User-Agent`. The UA header is on the fetch spec's "forbidden
// headers" list; any attempt to override it is silently dropped. The
// browser sends its real Chrome UA on every fetch we initiate. This
// rules out clients that the InnerTube server validates by UA — most
// notably IOS / ANDROID, where a non-matching UA produces a clean
// `400 Bad Request`. Our v0.11.2 client list is restricted to clients
// that either don't validate UA (TVHTML5, embed) or expect a
// browser-shaped UA (WEB_CREATOR, MWEB). Earlier iterations of this
// branch tried IOS first and got 400s — see commit history.
//
// We don't claim authoritative knowledge of YouTube's internal client
// roster — only that, as of the v0.11.2 ship date, these contexts
// return adaptiveFormats with URLs on public non-DRM watch pages. If
// every entry stops working at once, the SW log line points at the
// fault directly (see `youtube discoverStreams` + the per-client
// status logs in `fetchInnerTubePlayer`).

export interface InnerTubeClient {
  /** Short label used in logs ("IOS", "TV_EMBEDDED"). */
  name: string;
  /**
   * Public InnerTube API key for this client. These are constants baked
   * into YouTube's own client JS — not secrets. They're per-client
   * because different clients sometimes ship different keys; using the
   * wrong key for a given clientName 400s.
   */
  apiKey: string;
  /**
   * The `context.client` object posted with every InnerTube request.
   * Keep this minimal but truthy — the server validates a few fields
   * (clientName + clientVersion are the load-bearing ones; the rest
   * are nice-to-have for analytics on YouTube's side but don't
   * usually gate the response).
   */
  context: Record<string, string>;
  /**
   * Some embed-style clients require a `context.thirdParty.embedUrl`.
   * Setting this here keeps the call shape symmetric across clients.
   */
  thirdPartyEmbedUrl?: string;
}

// Well-known InnerTube API keys. These are public constants baked
// into YouTube's own client JS — not secrets. The WEB key works for
// almost every browser-shaped client (WEB / WEB_CREATOR / MWEB /
// TVHTML5 variants); other contexts ship their own keys but those
// require non-browser request signatures we can't fake.
const INNERTUBE_API_KEY_WEB = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';

/**
 * Ordered fallback list. Iteration stops at the first client whose
 * response carries adaptiveFormats with usable URLs. Order matters:
 *
 *  1. WEB_CREATOR — has historically returned adaptive URLs without
 *     a poToken, and the Chrome UA matches what this client expects
 *     (it's a web-platform client variant).
 *  2. MWEB — mobile-web fallback. Lower max bitrate than CREATOR but
 *     unlocks a different set of restrictions on some videos.
 *  3. TVHTML5 — full TV client. Few playback restrictions and the
 *     TV context tolerates any UA. Last because the response shape
 *     is more constrained (fewer codec options on some videos).
 *  4. TVHTML5_SIMPLY_EMBEDDED_PLAYER — the embed-only variant. Last
 *     resort; refuses many videos with `playabilityStatus !== 'OK'`
 *     for non-embed contexts.
 */
export const INNERTUBE_CLIENTS: readonly InnerTubeClient[] = [
  {
    name: 'WEB_CREATOR',
    apiKey: INNERTUBE_API_KEY_WEB,
    context: {
      clientName: 'WEB_CREATOR',
      clientVersion: '1.20240723.03.00',
      hl: 'en',
      gl: 'US',
    },
  },
  {
    name: 'MWEB',
    apiKey: INNERTUBE_API_KEY_WEB,
    context: {
      clientName: 'MWEB',
      clientVersion: '2.20240726.01.00',
      hl: 'en',
      gl: 'US',
    },
  },
  {
    name: 'TVHTML5',
    apiKey: INNERTUBE_API_KEY_WEB,
    context: {
      clientName: 'TVHTML5',
      clientVersion: '7.20240726.16.00',
      platform: 'TV',
      hl: 'en',
      gl: 'US',
    },
  },
  {
    name: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER',
    apiKey: INNERTUBE_API_KEY_WEB,
    context: {
      clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER',
      clientVersion: '2.0',
      platform: 'TV',
      hl: 'en',
      gl: 'US',
    },
    thirdPartyEmbedUrl: 'https://www.youtube.com/',
  },
];

/**
 * Build the request body for an InnerTube `/youtubei/v1/player` call.
 *
 * Exported so unit tests can assert shape without going through fetch.
 */
export function buildInnerTubePlayerBody(
  videoId: string,
  client: InnerTubeClient,
  poToken?: string,
): Record<string, unknown> {
  const context: Record<string, unknown> = {
    client: { ...client.context },
  };
  if (client.thirdPartyEmbedUrl) {
    context.thirdParty = { embedUrl: client.thirdPartyEmbedUrl };
  }
  return {
    context,
    videoId,
    // Attestation for this player request. v0.12 field work established
    // that the gate attaches to the ACQUISITION path, not to googlevideo
    // generally: URLs minted for the page's own WEB session fetch fine
    // with no token on the URL, while URLs from an unattested InnerTube
    // call are refused no matter what is appended to them later. So the
    // token belongs here, on the request that mints the URLs — not on
    // the media URL. Omitted entirely when unavailable, which is the
    // pre-v0.12 behavior.
    ...(poToken ? { serviceIntegrityDimensions: { poToken } } : {}),
    // Tells YouTube "yes I've accepted whatever content gates apply" —
    // matters mostly for embedded clients where the default is to
    // refuse anything age-gated / restricted with a status of
    // CONTENT_CHECK_REQUIRED. Real watch-page playback also sends
    // these. We still respect `playabilityStatus !== 'OK'` downstream
    // for DRM / unplayable / region-locked.
    contentCheckOk: true,
    racyCheckOk: true,
  };
}
