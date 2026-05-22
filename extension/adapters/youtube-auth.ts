// SAPISIDHASH computation for InnerTube `/youtubei/v1/player` calls
// (v0.11.2 follow-up).
//
// YouTube's own JS sends an `Authorization: SAPISIDHASH <ts>_<hex>`
// header on every InnerTube request. The server reads it as proof
// that the caller actually has the `SAPISID` auth cookie (not just
// a forged Origin / X-Origin header) and that the cookie matches a
// signed-in account. Without it, requests get treated as anonymous —
// which puts every non-WEB client behind a bot-check (`LOGIN_REQUIRED:
// "Sign in to confirm you're not a bot"`).
//
// The hash is the well-known YouTube/Google "sapisidhash"
// construction:
//
//   message = `${unix_seconds} ${SAPISID} ${origin}`
//   hash    = sha1_hex(message)
//   header  = `SAPISIDHASH ${unix_seconds}_${hash}`
//
// where `origin` is `https://www.youtube.com` for InnerTube. The
// `SAPISID` cookie is intentionally NOT HttpOnly precisely because
// YouTube's own frontend reads it via document.cookie to compute
// this hash on every API call.
//
// We compute this in the content-script context so document.cookie
// resolves to the watch page's youtube.com cookies. crypto.subtle is
// available there (same Web Crypto surface as the offscreen + SW).

const COOKIE_NAMES = ['SAPISID', '__Secure-3PAPISID', '__Secure-1PAPISID'];
const INNERTUBE_ORIGIN = 'https://www.youtube.com';

/**
 * Try every known SAPISID-shaped cookie name, in priority order, and
 * return the first one present. YouTube ships SAPISID under several
 * aliases depending on the user's account state — `SAPISID` for
 * standard accounts, `__Secure-3PAPISID` for third-party-cookie
 * restricted contexts, `__Secure-1PAPISID` as a first-party variant.
 * They all hash the same way.
 *
 * Returns null when none is present (user not signed in to YouTube,
 * cookies cleared, embedded context without auth cookies).
 */
function readSapisidFromCookies(cookieHeader: string): string | null {
  for (const name of COOKIE_NAMES) {
    const re = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`);
    const m = cookieHeader.match(re);
    if (m?.[1]) return m[1];
  }
  return null;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) {
    out += b.toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * Build a SAPISIDHASH Authorization header value for an InnerTube
 * call. Returns null when no SAPISID cookie is available — the
 * caller falls back to anonymous (which means non-WEB clients will
 * be bot-gated, but the call still issues so the diagnostic path
 * surfaces the gate explicitly).
 *
 * Pure aside from the call to `crypto.subtle.digest`, which is async.
 */
export async function computeSapisidhash(
  cookieHeader: string = typeof document !== 'undefined' ? document.cookie : '',
  origin: string = INNERTUBE_ORIGIN,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<string | null> {
  const sapisid = readSapisidFromCookies(cookieHeader);
  if (!sapisid) return null;
  const message = `${nowSeconds} ${sapisid} ${origin}`;
  const messageBytes = new TextEncoder().encode(message);
  const digest = await crypto.subtle.digest('SHA-1', messageBytes);
  const hex = bytesToHex(new Uint8Array(digest));
  return `SAPISIDHASH ${nowSeconds}_${hex}`;
}

/**
 * Extract the `visitorData` token from an inline player_response
 * shape. YouTube's per-session anti-bot fingerprint lives in
 * `responseContext.visitorData` — the WEB client carries it into
 * every InnerTube call as both `context.client.visitorData` and the
 * `X-Goog-Visitor-Id` header. Without it, bot-check gates trip
 * faster.
 *
 * Returns null when the field isn't present (very old responses,
 * embed contexts).
 */
export function extractVisitorData(
  player: { responseContext?: { visitorData?: string } } | null,
): string | null {
  return player?.responseContext?.visitorData ?? null;
}
