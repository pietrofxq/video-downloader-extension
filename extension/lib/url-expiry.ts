// Signed media URLs publish their own deadline. Reading it is what lets
// a 403 be classified honestly: "the signature aged out, a reload will
// mint a fresh one" versus "the server refused a URL that is still
// within its validity window", which is a different failure with a
// different remedy. Before this, every 403 was reported as an expiry.

const EXPIRY_PARAMS = new Set(['expire', 'expires', 'exp']);

// Akamai-style compound tokens (`hdntl=exp=1699...~acl=/*~hmac=...`)
// carry the deadline as a field inside the value rather than as its own
// query param. Hotmart is the in-repo case.
const TOKEN_BLOB_PARAMS = new Set(['hdntl', 'hdnts']);

// Below this, a value is far more likely to be a duration or an
// unrelated numeric field than an absolute epoch timestamp.
const MIN_PLAUSIBLE_EPOCH_SECONDS = 1_000_000_000;

function toEpochMs(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= MIN_PLAUSIBLE_EPOCH_SECONDS * 1000) return n;
  if (n >= MIN_PLAUSIBLE_EPOCH_SECONDS) return n * 1000;
  return null;
}

function expiryFromTokenBlob(blob: string): number | null {
  for (const field of blob.split('~')) {
    const eq = field.indexOf('=');
    if (eq < 0) continue;
    if (!EXPIRY_PARAMS.has(field.slice(0, eq).toLowerCase())) continue;
    const at = toEpochMs(field.slice(eq + 1));
    if (at !== null) return at;
  }
  return null;
}

/**
 * Epoch milliseconds at which the URL's signed credential lapses, or
 * null when the URL doesn't publish one.
 */
export function urlExpiresAt(url: string): number | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  for (const [key, value] of parsed.searchParams) {
    const k = key.toLowerCase();
    if (EXPIRY_PARAMS.has(k)) {
      const at = toEpochMs(value);
      if (at !== null) return at;
    } else if (TOKEN_BLOB_PARAMS.has(k)) {
      const at = expiryFromTokenBlob(value);
      if (at !== null) return at;
    }
  }
  return null;
}

/**
 * True only when the URL publishes a deadline that has already passed.
 * A missing or unparseable deadline is NOT expiry — callers must not
 * infer one, which is exactly the mistake the old blanket 403 →
 * "token expired" mapping made.
 */
export function isUrlExpired(url: string, nowMs: number = Date.now()): boolean {
  const at = urlExpiresAt(url);
  return at !== null && at <= nowMs;
}
