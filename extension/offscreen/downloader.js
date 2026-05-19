import { Parser } from 'm3u8-parser';
import { parseManifest } from '../lib/m3u8.js';
import { runWithConcurrency } from '../lib/concurrency.js';
import { uint8ArrayToBase64, base64ToUint8Array } from '../lib/base64.js';
import {
  TokenExpiredError,
  ManifestParseError,
  DecryptionError,
  UnsupportedFormatError,
} from '../lib/errors.js';
import { ivFromSequence, toUint8, importAesKey, decryptSegment } from './hls-decrypt.js';

const SEGMENT_CONCURRENCY = 4;

/**
 * @typedef {object} DownloadRequest
 * @property {string} requestId
 * @property {string} variantUrl   - chosen variant playlist URL (or media playlist for single-bitrate)
 * @property {number} tabId
 * @property {number} frameId      - frame ID to route proxy fetches to
 * @property {Record<string,string>} [headers]
 * @property {string} filename     - sanitized base name (no extension); orchestrator appends .ts
 */

/**
 * @typedef {object} DownloadOutcome
 * @property {string} requestId
 * @property {string} blobUrl
 * @property {string} filename
 * @property {number} bytes
 * @property {number} segments
 */

/**
 * @param {(payload: object) => Promise<object>} proxyFetch  - text + arrayBuffer fetcher (SW-routed)
 * @param {(progress: { stage: 'fetch'|'decrypt'|'concat', current: number, total: number }) => void} onProgress
 * @param {DownloadRequest} req
 * @returns {Promise<DownloadOutcome>}
 */
export async function downloadHlsAsTs({ proxyFetch, onProgress }, req) {
  const { requestId, variantUrl, tabId, frameId, headers, filename } = req;

  // 1. Fetch + parse the chosen variant playlist.
  const playlistText = await fetchText(proxyFetch, { tabId, frameId, url: variantUrl, headers });
  const parsed = safeParse(playlistText, variantUrl);

  // We expect a media playlist with segments at this point.
  if (parsed.isMaster) {
    throw new UnsupportedFormatError(
      'Expected a media playlist (variant) but got a master. Pick a quality and retry.',
    );
  }

  // Re-parse to extract segments via m3u8-parser's full output (parseManifest
  // currently returns segmentCount only; we need URIs + keys here).
  const segments = extractSegments(playlistText, variantUrl);
  if (segments.length === 0) {
    throw new ManifestParseError('Variant playlist contained no segments.');
  }
  const total = segments.length;
  onProgress({ stage: 'fetch', current: 0, total });

  // 2. Fetch + import the AES-128 key (if any). HLS supports per-segment
  //    key rotation, but in practice (and on Hotmart) one key covers all
  //    segments — we cache by key URL.
  const keyCache = new Map();
  async function getCryptoKey(keyUrl) {
    if (!keyUrl) return null;
    let cryptoKey = keyCache.get(keyUrl);
    if (cryptoKey !== undefined) return cryptoKey;
    const keyBytes = await fetchArrayBuffer(proxyFetch, {
      tabId,
      frameId,
      url: keyUrl,
      headers,
    });
    if (keyBytes.length !== 16) {
      throw new DecryptionError(`AES key at ${keyUrl} was ${keyBytes.length} bytes, expected 16.`);
    }
    cryptoKey = await importAesKey(keyBytes);
    keyCache.set(keyUrl, cryptoKey);
    return cryptoKey;
  }

  // 3. Fetch + decrypt segments with bounded concurrency. Each task returns
  //    the decrypted bytes for its segment.
  let fetched = 0;
  let decrypted = 0;
  const tasks = segments.map((seg) => async () => {
    const cipher = await fetchArrayBuffer(proxyFetch, {
      tabId,
      frameId,
      url: seg.url,
      headers,
    });
    fetched += 1;
    onProgress({ stage: 'fetch', current: fetched, total });

    if (!seg.encrypted) {
      return cipher;
    }
    const cryptoKey = await getCryptoKey(seg.keyUrl);
    if (!cryptoKey) {
      // KEY=NONE explicitly — pass through.
      return cipher;
    }
    const iv = seg.iv ?? ivFromSequence(seg.sequence);
    let plain;
    try {
      plain = await decryptSegment(cipher, cryptoKey, iv);
    } catch (err) {
      throw new DecryptionError(
        `decrypt failed for segment ${seg.sequence}: ${err?.message ?? err}`,
      );
    }
    decrypted += 1;
    onProgress({ stage: 'decrypt', current: decrypted, total });
    return plain;
  });

  const decryptedSegments = await runWithConcurrency(tasks, SEGMENT_CONCURRENCY);

  // 4. Concatenate into a single MPEG-TS buffer.
  onProgress({ stage: 'concat', current: 0, total: 1 });
  const bytes = concatenate(decryptedSegments);
  onProgress({ stage: 'concat', current: 1, total: 1 });

  // 5. Make a Blob URL for the SW to hand to chrome.downloads.download.
  const blob = new Blob([bytes], { type: 'video/mp2t' });
  const blobUrl = URL.createObjectURL(blob);
  return {
    requestId,
    blobUrl,
    filename: `${filename}.ts`,
    bytes: bytes.length,
    segments: total,
  };
}

// ---------- helpers ----------

function safeParse(text, baseUrl) {
  try {
    return parseManifest(text, baseUrl);
  } catch (err) {
    throw new ManifestParseError(err?.message ?? String(err));
  }
}

/**
 * Use m3u8-parser directly to get per-segment URIs, sequence numbers, and
 * key info. lib/m3u8.js exposes a more curated shape (variants + alternates);
 * the download pipeline needs the raw segment list.
 */
function extractSegments(text, baseUrl) {
  const parser = new Parser();
  parser.push(text);
  parser.end();
  const m = parser.manifest ?? {};
  const segs = Array.isArray(m.segments) ? m.segments : [];
  const startSeq = typeof m.mediaSequence === 'number' ? m.mediaSequence : 0;
  return segs.map((seg, i) => {
    const sequence = typeof seg.timeline === 'number' ? seg.timeline : startSeq + i;
    let url;
    try {
      url = new URL(seg.uri ?? '', baseUrl).toString();
    } catch {
      url = seg.uri ?? '';
    }
    const key = seg.key;
    const encrypted = !!key && key.method && key.method !== 'NONE';
    let keyUrl = '';
    if (encrypted && key.uri) {
      try {
        keyUrl = new URL(key.uri, baseUrl).toString();
      } catch {
        keyUrl = key.uri;
      }
    }
    return {
      url,
      sequence,
      encrypted,
      keyUrl,
      iv: toUint8(key?.iv),
    };
  });
}

async function fetchText(proxyFetch, { tabId, frameId, url, headers }) {
  const reply = await proxyFetch({ tabId, frameId, url, headers, responseType: 'text' });
  if (!reply?.ok) throwFromReply(reply, url);
  if (typeof reply.body !== 'string') {
    throw new ManifestParseError(`proxy fetch for ${url} returned non-string body`);
  }
  return reply.body;
}

async function fetchArrayBuffer(proxyFetch, { tabId, frameId, url, headers }) {
  const reply = await proxyFetch({ tabId, frameId, url, headers, responseType: 'arrayBuffer' });
  if (!reply?.ok) throwFromReply(reply, url);
  if (typeof reply.body !== 'string') {
    throw new Error(`proxy fetch for ${url} returned non-string base64 body`);
  }
  return base64ToUint8Array(reply.body);
}

function throwFromReply(reply, url) {
  const status = reply?.status ?? 0;
  const message = reply?.error ?? `proxy fetch failed for ${url}`;
  if (status === 403 || /\b403\b/.test(message) || /token/i.test(message)) {
    throw new TokenExpiredError(message);
  }
  throw new Error(message);
}

function concatenate(chunks) {
  let length = 0;
  for (const c of chunks) length += c.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

// uint8ArrayToBase64 is re-exported for completeness; the downloader doesn't
// use it directly but PROXY_FETCH replies encode bodies with it.
export { uint8ArrayToBase64 };
