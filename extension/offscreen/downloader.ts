import { Parser } from 'm3u8-parser';
import { runWithConcurrency } from '../lib/concurrency.js';
import { uint8ArrayToBase64, base64ToUint8Array } from '../lib/base64.js';
import {
  TokenExpiredError,
  PlaybackGatedError,
  ManifestParseError,
  DecryptionError,
  DRMProtectedError,
  UnsupportedFormatError,
} from '../lib/errors.js';
import { log, redactUrl } from '../lib/log.js';
import { urlExpiresAt } from '../lib/url-expiry.js';
import { ivFromSequence, toUint8, importAesKey, decryptSegment } from './hls-decrypt.js';
import { remuxTsToMp4ToOpfs, type RemuxSegmentSource } from './remux.js';
import { getSettings } from '../lib/settings.js';
import { OpfsWorkspace } from './storage.js';
import type { DownloadOutcome, DownloadRequest } from '../lib/types.ts';

// Internal shapes — kept private to this module. DownloadRequest /
// DownloadOutcome are public (re-exported via lib/types.ts).

export interface ProxyFetchPayload {
  tabId?: number;
  frameId?: number;
  url: string;
  headers?: Record<string, string>;
  responseType: 'text' | 'arrayBuffer';
}

export interface ProxyFetchReply {
  ok: boolean;
  status?: number;
  body?: string;
  error?: string;
  /** Response Content-Length when the server provided one. */
  contentLength?: number;
  /** Response Content-Range when the request was a Range query. */
  contentRange?: string;
}

export type ProxyFetch = (payload: ProxyFetchPayload) => Promise<ProxyFetchReply>;

export interface DownloadProgress {
  stage: 'fetch' | 'decrypt' | 'remux';
  /**
   * Phase-weighted progress units. `current/total` is the single 0-1
   * fraction the popup turns into a monotonic 0-100% bar across all
   * three stages. Without this the bar would reset to 0 each time the
   * stage changed (fetch 0→100, decrypt 0→100, remux 0→100).
   */
  current: number;
  total: number;
  /** Raw segment count within the active stage (for the counter label). */
  segmentCurrent: number;
  segmentTotal: number;
}

// Relative wall-time weights per segment for the unified progress bar.
// Picked from observed Hotmart lessons: fetch is network-bound and the
// bulk of the time, decrypt is microseconds of CPU, remux is mux.js +
// our moof/moov patching which is non-trivial for large files. The
// numbers don't have to be precise — only the relative order matters
// for the bar to feel honest. Exported as a frozen record so tests can
// reason about the schedule the downloader will actually use.
export const PROGRESS_WEIGHTS = Object.freeze({
  fetch: 4,
  decrypt: 1,
  remux: 5,
} as const);

/**
 * Pure (current, total) calculator for the unified progress bar. The
 * downloader's emit() closure is the production caller, but the same
 * math drives the tests that lock in the "bar never resets between
 * stages" invariant.
 *
 * `current` is the sum of completed phase work in weighted units;
 * `total` is the grand total across whatever phases this stream needs
 * (fetch+remux for clear streams, fetch+decrypt+remux for encrypted).
 *
 * Both values are integers as long as the inputs are.
 */
export function computeUnifiedProgress(
  segmentCount: number,
  hasEncrypted: boolean,
  fetched: number,
  decrypted: number,
  remuxed: number,
  weights: { fetch: number; decrypt: number; remux: number } = PROGRESS_WEIGHTS,
): { current: number; total: number } {
  const fetchTotal = segmentCount * weights.fetch;
  const decryptTotal = hasEncrypted ? segmentCount * weights.decrypt : 0;
  const remuxTotal = segmentCount * weights.remux;
  const current = fetched * weights.fetch + decrypted * weights.decrypt + remuxed * weights.remux;
  return { current, total: fetchTotal + decryptTotal + remuxTotal };
}

interface ParsedSegment {
  url: string;
  sequence: number;
  duration: number;
  encrypted: boolean;
  keyUrl: string;
  iv: Uint8Array | null;
}

export interface ParsedMediaPlaylist {
  isMaster: boolean;
  segments: ParsedSegment[];
}

/**
 * Resolves to the download outcome plus a `cleanup` callback that
 * disposes the OPFS workspace backing the output file. The caller is
 * responsible for invoking `cleanup` once the Blob URL has been read
 * (i.e. when REVOKE_BLOB lands) — the file lives in OPFS, so the
 * workspace cannot be disposed at function-return time the way it was
 * when the output Blob was held in JS heap.
 */
export interface DownloadResult {
  outcome: DownloadOutcome;
  cleanup: () => Promise<void>;
}

export async function downloadHlsAsTs(
  io: {
    proxyFetch: ProxyFetch;
    onProgress: (p: DownloadProgress) => void;
    /** Cancel handle wired through every async boundary in the pipeline. */
    signal?: AbortSignal;
  },
  req: DownloadRequest,
): Promise<DownloadResult> {
  const { proxyFetch, onProgress, signal } = io;
  const { requestId, variantUrl, tabId, frameId, headers, filename } = req;

  signal?.throwIfAborted();

  // 1. Fetch + parse the chosen variant playlist. Single-pass parser does
  //    #EXTM3U validation, master detection, and segment extraction.
  const playlistText = await fetchText(proxyFetch, {
    tabId,
    frameId,
    url: variantUrl,
    headers,
    signal,
  });
  signal?.throwIfAborted();
  const { isMaster, segments } = parsePlaylist(playlistText, variantUrl);

  if (isMaster) {
    throw new UnsupportedFormatError(
      'Expected a media playlist (variant) but got a master. Pick a quality and retry.',
    );
  }
  if (segments.length === 0) {
    throw new ManifestParseError('Variant playlist contained no segments.');
  }
  const total = segments.length;
  // Unified progress accounting. Phases contribute weighted units into a
  // single grand total so the bar advances 0→100% across fetch +
  // decrypt + remux instead of resetting at each stage boundary.
  const hasEncrypted = segments.some((s) => s.encrypted);
  let fetchedCount = 0;
  let decryptedCount = 0;
  let remuxedCount = 0;
  const emit = (
    stage: DownloadProgress['stage'],
    segmentCurrent: number,
    segmentTotal: number,
  ): void => {
    const { current, total: totalUnits } = computeUnifiedProgress(
      total,
      hasEncrypted,
      fetchedCount,
      decryptedCount,
      remuxedCount,
    );
    onProgress({ stage, current, total: totalUnits, segmentCurrent, segmentTotal });
  };
  emit('fetch', 0, total);

  // 2. Fetch + import the AES-128 key (if any). HLS supports per-segment
  //    key rotation, but in practice (and on Hotmart) one key covers all
  //    segments — we cache by key URL.
  const keyCache = new Map<string, CryptoKey>();
  async function getCryptoKey(keyUrl: string): Promise<CryptoKey | null> {
    if (!keyUrl) return null;
    const cached = keyCache.get(keyUrl);
    if (cached !== undefined) return cached;
    const keyBytes = await fetchArrayBuffer(proxyFetch, {
      tabId,
      frameId,
      url: keyUrl,
      headers,
      signal,
    });
    if (keyBytes.length !== 16) {
      throw new DecryptionError(`AES key at ${keyUrl} was ${keyBytes.length} bytes, expected 16.`);
    }
    const cryptoKey = await importAesKey(keyBytes);
    keyCache.set(keyUrl, cryptoKey);
    return cryptoKey;
  }

  // 3. Fetch + decrypt segments with bounded concurrency. Each task
  //    stages its decrypted bytes to OPFS at the segment's playlist
  //    index — only one segment lives in JS heap per worker at a time.
  //    A 2GB lesson that used to peak at ~2GB of accumulated TS now
  //    peaks at ~concurrency × max-segment-size (~16-32 MB). Concurrency
  //    is user-configurable (Settings → parallel segment downloads).
  const concurrency = (await getSettings()).concurrency;
  const workspace = await OpfsWorkspace.open(requestId);
  let succeeded = false;
  try {
    let fetched = 0;
    let decrypted = 0;
    const tasks = segments.map((seg, idx) => async (): Promise<void> => {
      signal?.throwIfAborted();
      const cipher = await fetchArrayBuffer(proxyFetch, {
        tabId,
        frameId,
        url: seg.url,
        headers,
        signal,
      });
      signal?.throwIfAborted();
      fetched += 1;
      fetchedCount = fetched;
      emit('fetch', fetched, total);

      let bytes: Uint8Array;
      if (!seg.encrypted) {
        bytes = cipher;
      } else {
        const cryptoKey = await getCryptoKey(seg.keyUrl);
        if (!cryptoKey) {
          // Encrypted segment with no resolvable key URL is a manifest defect.
          throw new DecryptionError(
            `segment ${seg.sequence} is marked encrypted but has no resolvable key URL`,
          );
        }
        const iv = seg.iv ?? ivFromSequence(seg.sequence);
        try {
          bytes = await decryptSegment(cipher, cryptoKey, iv);
        } catch (err) {
          throw new DecryptionError(
            `decrypt failed for segment ${seg.sequence}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        decrypted += 1;
        decryptedCount = decrypted;
        emit('decrypt', decrypted, total);
      }
      await workspace.writeSegment(idx, bytes);
    });

    await runWithConcurrency(tasks, concurrency, undefined, signal);
    signal?.throwIfAborted();

    // 4. Stream segments back from OPFS into mux.js. RemuxSegmentSource
    //    yields one decrypted segment at a time so the array of bytes is
    //    never held in memory all at once. Per-segment push + flush is
    //    mux.js's intended VOD pattern (single concatenation produces a
    //    wrong-tfdt giant moof — see AGENTS.md §8a).
    // Make sure fetch/decrypt counters are saturated before remux starts
    // so the unified bar can never visually regress when the stage flips.
    fetchedCount = total;
    if (hasEncrypted) decryptedCount = total;
    emit('remux', 0, segments.length);
    const segmentSource: RemuxSegmentSource = {
      count: segments.length,
      async getSegment(index) {
        const bytes = await workspace.readSegment(index);
        return { bytes, duration: segments[index].duration };
      },
    };
    // 4b. Stream the remux output straight to an OPFS file. The whole
    //     MP4 is never materialized in JS heap — only the small init
    //     segment + per-moof headers stay in memory long enough to be
    //     patched + written back. The downloader returns a File-backed
    //     Blob URL; chrome.downloads.download reads from OPFS directly.
    const outputHandle = await workspace.createOutputFile(OUTPUT_FILE_NAME);
    const { bytes: outputBytes } = await remuxTsToMp4ToOpfs(
      segmentSource,
      outputHandle,
      ({ done, totalSegs }) => {
        remuxedCount = done;
        emit('remux', done, totalSegs);
      },
      signal,
    );
    signal?.throwIfAborted();

    // 5. Make a Blob URL for the SW to hand to chrome.downloads.download.
    //    The File is backed by OPFS; the Blob URL streams from disk.
    const outputFile = await workspace.getOutputFile(OUTPUT_FILE_NAME);
    const blobUrl = URL.createObjectURL(outputFile);
    succeeded = true;
    return {
      outcome: {
        requestId,
        blobUrl,
        filename: `${filename}.mp4`,
        bytes: outputBytes,
        segments: total,
      },
      // Workspace stays alive until REVOKE_BLOB arrives so chrome.downloads
      // can read the OPFS-backed Blob URL without races.
      cleanup: () => workspace.dispose(),
    };
  } finally {
    // On error / abort we still own the workspace cleanup. Success path
    // hands ownership to the caller via `cleanup` above.
    if (!succeeded) {
      await workspace.dispose();
    }
  }
}

const OUTPUT_FILE_NAME = 'out.mp4';

// ---------- helpers ----------

// Pre-flight pass: m3u8-parser silently DROPS EXT-X-KEY tags whose
// method isn't AES-128 (it returns key=undefined on the segment). That
// would let us treat encrypted segments as plain TS and ship garbage to
// mux.js. Scan the raw text for #EXT-X-KEY:METHOD=... tags and refuse
// anything we don't actually support before handing off to the parser.
const KEY_METHOD_RE = /^[ \t]*#EXT-X-KEY:[^\r\n]*\bMETHOD=([A-Z0-9\-_]+)/gim;
function rejectUnsupportedKeyMethods(text: string): void {
  KEY_METHOD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = KEY_METHOD_RE.exec(text)) !== null) {
    const method = (m[1] || '').toUpperCase();
    if (method === 'NONE' || method === 'AES-128') continue;
    if (method === 'SAMPLE-AES' || method === 'SAMPLE-AES-CTR') {
      throw new DRMProtectedError(
        `HLS ${method} samples-encrypted streams (FairPlay / Common-Encryption) are not supported.`,
      );
    }
    throw new UnsupportedFormatError(
      `Unsupported HLS encryption method "${method}". Only AES-128 is supported.`,
    );
  }
}

// Single-pass parse for the download pipeline. Validates the manifest is
// HLS, detects master vs media, and extracts per-segment URIs + key info.
// lib/m3u8.js exposes a more curated shape (variants + alternates) for
// the popup; this is the raw segment list we need to drive decryption.
//
// Exported so the test suite can exercise the encryption-method gate,
// implicit/explicit IV handling, and malformed-manifest rejection
// without spinning up the full proxyFetch + mux.js integration path.
export function parsePlaylist(text: unknown, baseUrl: string): ParsedMediaPlaylist {
  if (typeof text !== 'string' || !text.trim().startsWith('#EXTM3U')) {
    throw new ManifestParseError('Not an HLS manifest (missing #EXTM3U)');
  }
  rejectUnsupportedKeyMethods(text);
  const parser = new Parser();
  parser.push(text);
  parser.end();
  const m = parser.manifest ?? {};
  const playlists = Array.isArray(m.playlists) ? m.playlists : [];
  if (playlists.length > 0) {
    return { isMaster: true, segments: [] };
  }
  const segs = Array.isArray(m.segments) ? m.segments : [];
  const startSeq = typeof m.mediaSequence === 'number' ? m.mediaSequence : 0;
  const segments: ParsedSegment[] = segs.map((seg, i) => {
    let url: string;
    try {
      url = new URL(seg.uri ?? '', baseUrl).toString();
    } catch {
      url = seg.uri ?? '';
    }
    const key = seg.key;
    // HLS encryption methods per RFC 8216 §4.4.4.4 + IANA registry:
    //  - NONE                          → pass-through
    //  - AES-128                       → full-segment AES-CBC, supported
    //  - SAMPLE-AES, SAMPLE-AES-CTR    → per-sample crypto, typically FairPlay/Common-Encryption (DRM)
    //  - any other value               → newer/proprietary; refuse rather
    //                                    than silently mis-decrypt with the AES-CBC assumption.
    const rawMethod = typeof key?.method === 'string' ? key.method : '';
    const method = rawMethod.toUpperCase();
    const encrypted = !!key && !!method && method !== 'NONE';
    if (encrypted && method !== 'AES-128') {
      if (method === 'SAMPLE-AES' || method === 'SAMPLE-AES-CTR') {
        throw new DRMProtectedError(
          `HLS ${method} samples-encrypted streams (FairPlay / Common-Encryption) are not supported.`,
        );
      }
      throw new UnsupportedFormatError(
        `Unsupported HLS encryption method "${rawMethod}". Only AES-128 is supported.`,
      );
    }
    let keyUrl = '';
    if (encrypted && key?.uri) {
      try {
        keyUrl = new URL(key.uri, baseUrl).toString();
      } catch {
        keyUrl = key.uri;
      }
    }
    return {
      url,
      // mediaSequence + array index per RFC 8216 §6.2.2. m3u8-parser's
      // seg.timeline is the discontinuity counter (always 0 on continuous
      // playlists) — using it would feed wrong IVs into every segment
      // after the first on streams without EXT-X-KEY:IV=.
      sequence: startSeq + i,
      // Segment duration (seconds) from #EXTINF. Used to drive mux.js's
      // per-segment baseMediaDecodeTime in the remux step.
      duration: typeof seg.duration === 'number' ? seg.duration : 0,
      encrypted,
      keyUrl,
      iv: toUint8(key?.iv),
    };
  });
  return { isMaster: false, segments };
}

interface FetchArgs {
  tabId: number;
  frameId: number;
  url: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

// Retry budget for transient segment / key failures. 5 total attempts
// means 4 backoff sleeps: 500ms · 1s · 2s · 4s (+ ≤300ms jitter each)
// ≈ ~7.5s of total wall time — well inside the typical signed-URL TTL
// on Hotmart's hdntl token. (4 attempts would cap the sleeps at 2s and
// never reach the `Math.min(4000, …)` ceiling below.)
const MAX_FETCH_ATTEMPTS = 5;

// Exported for the test suite — see downloader.test.ts. Internal callers
// should not depend on this directly; the rest of the pipeline goes
// through proxyFetchWithRetry which already uses it.
export { isRetryableReply, proxyFetchWithRetry };

// Classify a proxy reply as "retry might help":
//  - HTTP 429 (rate-limited)
//  - HTTP 5xx (server failure)
//  - status 0 (the content-script fetch threw — network glitch,
//    CDN reset, frame torn down mid-request, etc.)
// Explicit allowlist so non-transient failures (4xx other than 429,
// notably 403 token-expired) fail fast instead of stalling on retries.
function isRetryableReply(reply: ProxyFetchReply | undefined): boolean {
  if (!reply) return true; // proxyFetch threw — treat as transient
  if (reply.ok) return false;
  const status = reply.status ?? 0;
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  if (status === 0) return true; // network error from the content-script side
  return false;
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason ?? new DOMException('aborted', 'AbortError');
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function proxyFetchWithRetry(
  proxyFetch: ProxyFetch,
  payload: ProxyFetchPayload,
  signal?: AbortSignal,
): Promise<ProxyFetchReply> {
  let attempt = 0;
  let lastReply: ProxyFetchReply | undefined;
  while (attempt < MAX_FETCH_ATTEMPTS) {
    signal?.throwIfAborted();
    lastReply = await proxyFetch(payload);
    if (lastReply.ok) return lastReply;
    if (!isRetryableReply(lastReply)) return lastReply;
    attempt += 1;
    if (attempt >= MAX_FETCH_ATTEMPTS) break;
    // Exponential backoff: 500ms · 1s · 2s · 4s with up to 300ms jitter.
    const base = Math.min(4000, 500 * 2 ** (attempt - 1));
    await sleep(base + Math.random() * 300, signal);
  }
  return lastReply ?? { ok: false, status: 0, error: 'proxy fetch returned no reply' };
}

async function fetchText(
  proxyFetch: ProxyFetch,
  { tabId, frameId, url, headers, signal }: FetchArgs,
): Promise<string> {
  const reply = await proxyFetchWithRetry(
    proxyFetch,
    { tabId, frameId, url, headers, responseType: 'text' },
    signal,
  );
  if (!reply?.ok) throwFromReply(reply, url);
  if (typeof reply.body !== 'string') {
    throw new ManifestParseError(`proxy fetch for ${url} returned non-string body`);
  }
  return reply.body;
}

async function fetchArrayBuffer(
  proxyFetch: ProxyFetch,
  { tabId, frameId, url, headers, signal }: FetchArgs,
): Promise<Uint8Array> {
  const reply = await proxyFetchWithRetry(
    proxyFetch,
    { tabId, frameId, url, headers, responseType: 'arrayBuffer' },
    signal,
  );
  if (!reply?.ok) throwFromReply(reply, url);
  if (typeof reply.body !== 'string') {
    throw new Error(`proxy fetch for ${url} returned non-string base64 body`);
  }
  return base64ToUint8Array(reply.body);
}

function throwFromReply(reply: ProxyFetchReply | undefined, url: string): never {
  const status = reply?.status ?? 0;
  const message = reply?.error ?? `proxy fetch failed for ${url}`;
  // Status check only — the prior substring regex misclassified any URL
  // whose path contained "token" (e.g. /token-validation-error.png) or
  // "403" (e.g. a 404 on a path with "403" in it).
  if (status === 403) {
    // Only claim expiry when the URL actually says it expired. A 403 on
    // a URL still inside its validity window is a gate, not a stale
    // credential, and telling the user to reload wastes their time.
    const expiresAt = urlExpiresAt(url);
    if (expiresAt !== null && expiresAt <= Date.now()) {
      throw new TokenExpiredError(message);
    }
    log.warn('403 on a URL that has not expired — treating as gated', {
      url: redactUrl(url),
      expiresAt: expiresAt === null ? 'not declared' : new Date(expiresAt).toISOString(),
    });
    throw new PlaybackGatedError(message);
  }
  throw new Error(`${message} (HTTP ${status})`);
}

// uint8ArrayToBase64 is re-exported for completeness; the downloader doesn't
// use it directly but PROXY_FETCH replies encode bodies with it.
export { uint8ArrayToBase64 };
export { fetchArrayBuffer, fetchText, throwFromReply };
export type { FetchArgs };
