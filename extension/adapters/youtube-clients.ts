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
// Chrome's content-script `fetch()` cannot set `User-Agent` — it is on
// the fetch spec's "forbidden headers" list, so the browser sends its
// real Chrome UA on every request we make.
//
// CORRECTION (v0.12). Earlier notes here concluded that this ruled out
// the mobile clients, because IOS / ANDROID returned a clean `400`.
// That diagnosis was wrong and it cost the project a lot: it pointed
// the whole investigation at BotGuard/poToken work that turned out to
// be unnecessary. The 400 comes from sending the web session's
// `Authorization: SAPISIDHASH` header to a non-web client, which
// rejects that auth shape outright. Drop the header and supply
// visitorData instead and ANDROID_VR answers `OK` from a plain
// content-script fetch under the ordinary Chrome UA — see
// `omitAccountAuth` / `requiresVisitorData` below.
//
// The lesson worth keeping: a bare 400 from InnerTube says "malformed
// for this client", not "wrong User-Agent". Vary the auth shape before
// concluding a client is unreachable.
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
  /**
   * Send WITHOUT the web account's `Authorization: SAPISIDHASH` /
   * `X-Origin` headers.
   *
   * Non-web clients reject web-session account auth outright: sending
   * it to ANDROID_VR returns a bare `400`. That 400 is what earlier
   * work misread as User-Agent validation (see AGENTS.md §8 #18) and
   * is why these clients were written off. They are not UA-gated at
   * all — they are auth-shape-gated.
   */
  omitAccountAuth?: boolean;
  /**
   * Client is refused with `LOGIN_REQUIRED` unless a visitorData
   * fingerprint is supplied. Skip the client entirely when we don't
   * have one rather than burning a request that cannot succeed.
   */
  requiresVisitorData?: boolean;
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
 *  1. ANDROID_VR — the only client whose adaptive URLs the CDN
 *     actually serves (v0.12 field-verified, including 4K). Needs
 *     visitorData and no account-auth header; see its entry below.
 *  2. WEB_CREATOR — returns a full adaptive catalog, but as of v0.12
 *     every URL from it 403s without a poToken. Kept because it is
 *     still the richest *inventory* and the popup shows it; if
 *     ANDROID_VR ever stops answering, this is the fallback that at
 *     least surfaces what exists.
 *  3. MWEB — same gated situation as WEB_CREATOR, different
 *     restriction set on some videos.
 *  4. TVHTML5 — full TV client. Returns adaptiveFormats with no URLs
 *     at all under SABR, so it is inventory-only in practice.
 *  5. TVHTML5_SIMPLY_EMBEDDED_PLAYER — embed-only variant, now
 *     answering "no longer supported in this application or device"
 *     for most videos. Last resort.
 */
export const INNERTUBE_CLIENTS: readonly InnerTubeClient[] = [
  {
    // First because it is the only client we've found that returns
    // adaptive URLs the CDN actually serves. Field-verified on a 4K
    // HDR video: 26 adaptive formats all carrying URLs, up to 2160p,
    // and itag 401 (AV1 2160p) + itag 140 (AAC) both fetched 206 with
    // real `ftypdash` bytes — no poToken anywhere in the flow.
    //
    // Two non-obvious requirements, both load-bearing:
    //   - visitorData is mandatory (without it: LOGIN_REQUIRED).
    //   - the SAPISIDHASH header must NOT be sent (with it: 400).
    //
    // Its URLs also carry no `n` param, so the signature solver is
    // skipped entirely on this path.
    name: 'ANDROID_VR',
    apiKey: INNERTUBE_API_KEY_WEB,
    omitAccountAuth: true,
    requiresVisitorData: true,
    context: {
      clientName: 'ANDROID_VR',
      clientVersion: '1.60.19',
      deviceMake: 'Oculus',
      deviceModel: 'Quest 3',
      osName: 'Android',
      osVersion: '12',
      androidSdkVersion: '32',
      hl: 'en',
      gl: 'US',
    },
  },
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
