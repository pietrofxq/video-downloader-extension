import { Parser } from 'm3u8-parser';
import { runWithConcurrency } from '../lib/concurrency.js';
import { uint8ArrayToBase64, base64ToUint8Array } from '../lib/base64.js';
import {
  TokenExpiredError,
  ManifestParseError,
  DecryptionError,
  DRMProtectedError,
  UnsupportedFormatError,
} from '../lib/errors.js';
import { ivFromSequence, toUint8, importAesKey, decryptSegment } from './hls-decrypt.js';
import { remuxTsToMp4 } from './remux.js';
import type { DownloadOutcome, DownloadRequest } from '../lib/types.ts';

const SEGMENT_CONCURRENCY = 4;

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
}

export type ProxyFetch = (payload: ProxyFetchPayload) => Promise<ProxyFetchReply>;

export interface DownloadProgress {
  stage: 'fetch' | 'decrypt' | 'remux';
  current: number;
  total: number;
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

export async function downloadHlsAsTs(
  io: { proxyFetch: ProxyFetch; onProgress: (p: DownloadProgress) => void },
  req: DownloadRequest,
): Promise<DownloadOutcome> {
  const { proxyFetch, onProgress } = io;
  const { requestId, variantUrl, tabId, frameId, headers, filename } = req;

  // 1. Fetch + parse the chosen variant playlist. Single-pass parser does
  //    #EXTM3U validation, master detection, and segment extraction.
  const playlistText = await fetchText(proxyFetch, { tabId, frameId, url: variantUrl, headers });
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
  onProgress({ stage: 'fetch', current: 0, total });

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
    });
    if (keyBytes.length !== 16) {
      throw new DecryptionError(`AES key at ${keyUrl} was ${keyBytes.length} bytes, expected 16.`);
    }
    const cryptoKey = await importAesKey(keyBytes);
    keyCache.set(keyUrl, cryptoKey);
    return cryptoKey;
  }

  // 3. Fetch + decrypt segments with bounded concurrency. Each task returns
  //    { bytes, duration } so we preserve the original per-segment boundary
  //    + duration for the remux step (mux.js needs per-segment pushes).
  let fetched = 0;
  let decrypted = 0;
  const tasks = segments.map(
    (seg) => async (): Promise<{ bytes: Uint8Array; duration: number }> => {
      const cipher = await fetchArrayBuffer(proxyFetch, {
        tabId,
        frameId,
        url: seg.url,
        headers,
      });
      fetched += 1;
      onProgress({ stage: 'fetch', current: fetched, total });

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
        onProgress({ stage: 'decrypt', current: decrypted, total });
      }
      return { bytes, duration: seg.duration };
    },
  );

  const decryptedSegments = await runWithConcurrency(tasks, SEGMENT_CONCURRENCY);

  // 4. Remux per-segment via mux.js. Pushing each segment with
  //    setBaseMediaDecodeTime(cumulative) is mux.js's intended VOD pattern;
  //    pushing one big concatenation produces ONE giant moof with the
  //    wrong baseMediaDecodeTime (VLC then reports a duration in hundreds
  //    of hours and plays nothing).
  onProgress({ stage: 'remux', current: 0, total: decryptedSegments.length });
  const mp4Bytes = await remuxTsToMp4(decryptedSegments, ({ done, totalSegs }) => {
    onProgress({ stage: 'remux', current: done, total: totalSegs });
  });

  // 5. Make a Blob URL for the SW to hand to chrome.downloads.download.
  const blob = new Blob([mp4Bytes as Uint8Array<ArrayBuffer>], { type: 'video/mp4' });
  const blobUrl = URL.createObjectURL(blob);
  return {
    requestId,
    blobUrl,
    filename: `${filename}.mp4`,
    bytes: mp4Bytes.length,
    segments: total,
  };
}

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
}

async function fetchText(
  proxyFetch: ProxyFetch,
  { tabId, frameId, url, headers }: FetchArgs,
): Promise<string> {
  const reply = await proxyFetch({ tabId, frameId, url, headers, responseType: 'text' });
  if (!reply?.ok) throwFromReply(reply, url);
  if (typeof reply.body !== 'string') {
    throw new ManifestParseError(`proxy fetch for ${url} returned non-string body`);
  }
  return reply.body;
}

async function fetchArrayBuffer(
  proxyFetch: ProxyFetch,
  { tabId, frameId, url, headers }: FetchArgs,
): Promise<Uint8Array> {
  const reply = await proxyFetch({ tabId, frameId, url, headers, responseType: 'arrayBuffer' });
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
    throw new TokenExpiredError(message);
  }
  throw new Error(message);
}

// uint8ArrayToBase64 is re-exported for completeness; the downloader doesn't
// use it directly but PROXY_FETCH replies encode bodies with it.
export { uint8ArrayToBase64 };
