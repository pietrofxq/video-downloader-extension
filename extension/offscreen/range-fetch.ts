// Chunked Range-based proxy fetch (v0.11.3).
//
// The default `fetchArrayBuffer` does one shot through the
// content-script proxy, base64-encodes the whole body, and posts it
// back over `chrome.runtime.sendMessage`. That works for sub-100 MB
// payloads (HLS segments, YouTube progressive 360p, audio tracks
// even at high bitrates) but trips Chrome's practical message-size
// cap on 1080p adaptive video at typical YouTube bitrates (200–500 MB
// raw, ~270–680 MB base64).
//
// This helper splits the fetch into Range requests. Each chunk lives
// briefly in transit as its own base64 message and is appended into a
// single output `Uint8Array` allocated up-front from the total length.
// Heap usage is the final size (acceptable — JS handles 500 MB Uint8s
// fine in the offscreen document); transit per chunk is bounded.
//
// Why one big Uint8Array instead of streaming to OPFS? Two reasons:
//   1. `combineFmp4` expects both inputs as Uint8Array. Streaming
//      one side to OPFS would require also threading file-source
//      reads through the muxer — separate, larger change. v1.3 work.
//   2. The wall we're hitting is *transit*, not heap. The 1-Uint8
//      path solves transit cleanly without touching the muxer.

import { proxyFetchWithRetry, throwFromReply, type ProxyFetch } from './downloader.js';
import { base64ToUint8Array } from '../lib/base64.js';
import { log, redactUrl } from '../lib/log.js';

/** Per-chunk size in bytes. 8 MB raw → ~10.7 MB base64; under
 *  Chrome's per-message practical cap with comfortable margin. */
export const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024;

export interface RangeFetchArgs {
  proxyFetch: ProxyFetch;
  tabId: number;
  frameId: number;
  url: string;
  headers?: Record<string, string>;
  /** Reported as `(written, total)` after each chunk lands. */
  onProgress?: (written: number, total: number) => void;
  signal?: AbortSignal;
  /** Override the per-chunk size (testing). */
  chunkBytes?: number;
  /**
   * Total size when the caller already knows it from out-of-band
   * metadata — googlevideo publishes it as the URL's `clen`, and
   * YouTube's format list carries `contentLength`.
   *
   * Worth supplying: cross-origin responses have `Content-Range`
   * stripped by CORS, so this fetcher otherwise cannot see the total
   * and has to poll for EOF while reporting a progress denominator it
   * is guessing at. On a multi-GB download that guess is what makes
   * the popup appear frozen.
   */
  knownTotalBytes?: number;
}

/**
 * Fetch a URL via repeated `Range: bytes=A-B` GETs through the
 * content-script proxy and concatenate the results into a single
 * `Uint8Array`. Two paths:
 *
 *  - **Known total**: the first chunk's `Content-Range` header
 *    reveals the full file size, and we pre-allocate one
 *    `Uint8Array(total)` and loop until written == total.
 *  - **Unknown total** (Content-Range has `*` for the total, or
 *    the header is missing entirely): we accumulate chunks in a
 *    list and stop when a chunk comes back shorter than the
 *    requested chunk size (the server's EOF signal).
 *
 * The unknown-total path is what lets us survive googlevideo
 * responses where the CDN doesn't publish the total size up-front.
 * The previous implementation trusted `Content-Length` as the total,
 * which is wrong for 206 responses — that field carries the chunk
 * size, not the file size. A 1080p video would get truncated to one
 * chunk (~8 MB) and the muxer would later fail on the partial mdat.
 *
 * Throws on the first failed chunk (no partial returns).
 *
 * Exported so unit tests can drive it against a mocked proxyFetch.
 */
export async function fetchArrayBufferRanged(args: RangeFetchArgs): Promise<Uint8Array> {
  const { proxyFetch, tabId, frameId, url, headers, onProgress, signal } = args;
  const chunkBytes = args.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  signal?.throwIfAborted();

  const firstReply = await proxyFetchWithRetry(
    proxyFetch,
    {
      tabId,
      frameId,
      url,
      headers: { ...(headers ?? {}), Range: `bytes=0-${chunkBytes - 1}` },
      responseType: 'arrayBuffer',
    },
    signal,
  );
  if (!firstReply.ok) {
    throwFromReply(firstReply, url);
  }
  if (typeof firstReply.body !== 'string') {
    throw new Error(`proxy fetch for ${url} returned non-string body on initial Range request`);
  }
  const firstBytes = base64ToUint8Array(firstReply.body);
  const sizeInfo = parseTotalSize(firstReply, firstBytes.byteLength);

  // One-line diagnostic so a future truncation surfaces immediately —
  // the contentRange / contentLength values that drive the total
  // are otherwise invisible at the offscreen log level.
  log.info('range-fetch: first chunk received', {
    url: redactUrl(url),
    bytes: firstBytes.byteLength,
    status: firstReply.status,
    contentRange: firstReply.contentRange,
    contentLength: firstReply.contentLength,
    total: sizeInfo.total,
    knownTotal: sizeInfo.known,
  });

  // Short-circuit: the server returned everything in the first
  // chunk (server ignored Range or the file is smaller than
  // chunkBytes). Detected either by a known total ≤ what we got,
  // or by the chunk being smaller than what we asked for (EOF).
  if (sizeInfo.known && firstBytes.byteLength >= sizeInfo.total) {
    onProgress?.(firstBytes.byteLength, firstBytes.byteLength);
    return firstBytes;
  }
  if (!sizeInfo.known && firstBytes.byteLength < chunkBytes) {
    onProgress?.(firstBytes.byteLength, firstBytes.byteLength);
    return firstBytes;
  }

  if (sizeInfo.known) {
    // Pre-allocated path — most efficient when the server reports
    // the total. Cheap on memory pressure (one allocation up front).
    const out = new Uint8Array(sizeInfo.total);
    out.set(firstBytes, 0);
    let written = firstBytes.byteLength;
    onProgress?.(written, sizeInfo.total);

    while (written < sizeInfo.total) {
      signal?.throwIfAborted();
      const end = Math.min(written + chunkBytes - 1, sizeInfo.total - 1);
      const reply = await proxyFetchWithRetry(
        proxyFetch,
        {
          tabId,
          frameId,
          url,
          headers: { ...(headers ?? {}), Range: `bytes=${written}-${end}` },
          responseType: 'arrayBuffer',
        },
        signal,
      );
      if (!reply.ok) {
        throwFromReply(reply, url);
      }
      if (typeof reply.body !== 'string') {
        throw new Error(
          `proxy fetch for ${url} returned non-string body on chunk starting at ${written}`,
        );
      }
      const chunk = base64ToUint8Array(reply.body);
      out.set(chunk, written);
      written += chunk.byteLength;
      onProgress?.(written, sizeInfo.total);
    }
    return out;
  }

  // Unknown-total path — accumulate chunks until a short one
  // signals EOF, then concatenate. Costs one extra allocation pass
  // at the end but works against servers that don't advertise the
  // total size up-front.
  const chunks: Uint8Array[] = [firstBytes];
  let written = firstBytes.byteLength;
  onProgress?.(written, written);
  while (true) {
    signal?.throwIfAborted();
    const end = written + chunkBytes - 1;
    const reply = await proxyFetchWithRetry(
      proxyFetch,
      {
        tabId,
        frameId,
        url,
        headers: { ...(headers ?? {}), Range: `bytes=${written}-${end}` },
        responseType: 'arrayBuffer',
      },
      signal,
    );
    if (!reply.ok) {
      // 416 (Requested Range Not Satisfiable) is the canonical
      // "we're past EOF" signal when the previous chunk landed
      // exactly on the file boundary. Treat it as a successful
      // termination, not a failure.
      if (reply.status === 416) break;
      throwFromReply(reply, url);
    }
    if (typeof reply.body !== 'string') {
      throw new Error(
        `proxy fetch for ${url} returned non-string body on chunk starting at ${written}`,
      );
    }
    const chunk = base64ToUint8Array(reply.body);
    if (chunk.byteLength === 0) break;
    chunks.push(chunk);
    written += chunk.byteLength;
    onProgress?.(written, written);
    if (chunk.byteLength < chunkBytes) break; // short chunk = EOF
  }
  const out = new Uint8Array(written);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/**
 * Same Range-fetch loop as {@link fetchArrayBufferRanged} but each
 * chunk is appended directly to an OPFS file via positioned writes
 * instead of accumulating in a JS-heap Uint8Array. Peak JS heap is
 * one chunk (~8 MB) regardless of file size — required for the
 * v0.11.5 4K path where the full stream is 1-3 GB per side and would
 * OOM the offscreen document if buffered.
 *
 * The output handle is truncated at start; on completion the file's
 * byte length equals `bytes`.
 */
export interface RangeFetchToOpfsArgs extends Omit<RangeFetchArgs, 'onProgress'> {
  outputHandle: FileSystemFileHandle;
  /** Reported as `(written, total)` after each chunk lands. `total` is
   *  the chunk-sized lower bound until EOF, at which point it snaps to
   *  the final value. */
  onProgress?: (written: number, total: number) => void;
}

export async function fetchToOpfsRanged(args: RangeFetchToOpfsArgs): Promise<{ bytes: number }> {
  const { proxyFetch, tabId, frameId, url, headers, onProgress, signal, outputHandle } = args;
  const chunkBytes = args.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  signal?.throwIfAborted();

  const writable = await outputHandle.createWritable({ keepExistingData: false });
  let written = 0;
  const writeChunk = async (chunk: Uint8Array): Promise<void> => {
    if (chunk.byteLength === 0) return;
    await writable.write(chunk as Uint8Array<ArrayBuffer>);
    written += chunk.byteLength;
  };

  try {
    const firstReply = await proxyFetchWithRetry(
      proxyFetch,
      {
        tabId,
        frameId,
        url,
        headers: { ...(headers ?? {}), Range: `bytes=0-${chunkBytes - 1}` },
        responseType: 'arrayBuffer',
      },
      signal,
    );
    if (!firstReply.ok) {
      throwFromReply(firstReply, url);
    }
    if (typeof firstReply.body !== 'string') {
      throw new Error(`proxy fetch for ${url} returned non-string body on initial Range request`);
    }
    const firstBytes = base64ToUint8Array(firstReply.body);
    // A caller-supplied total beats sniffing the response: CORS strips
    // Content-Range on googlevideo, so parseTotalSize would report
    // "unknown" and fall back to EOF polling with a guessed denominator.
    const sizeInfo =
      args.knownTotalBytes && args.knownTotalBytes > 0
        ? { total: args.knownTotalBytes, known: true }
        : parseTotalSize(firstReply, firstBytes.byteLength);

    log.info('range-fetch-opfs: first chunk received', {
      url: redactUrl(url),
      bytes: firstBytes.byteLength,
      status: firstReply.status,
      contentRange: firstReply.contentRange,
      contentLength: firstReply.contentLength,
      total: sizeInfo.total,
      knownTotal: sizeInfo.known,
    });

    await writeChunk(firstBytes);
    onProgress?.(written, sizeInfo.known ? sizeInfo.total : written);

    // Short-circuit identical to the in-memory path.
    if (sizeInfo.known && written >= sizeInfo.total) {
      return { bytes: written };
    }
    if (!sizeInfo.known && firstBytes.byteLength < chunkBytes) {
      return { bytes: written };
    }

    if (sizeInfo.known) {
      while (written < sizeInfo.total) {
        signal?.throwIfAborted();
        const end = Math.min(written + chunkBytes - 1, sizeInfo.total - 1);
        const reply = await proxyFetchWithRetry(
          proxyFetch,
          {
            tabId,
            frameId,
            url,
            headers: { ...(headers ?? {}), Range: `bytes=${written}-${end}` },
            responseType: 'arrayBuffer',
          },
          signal,
        );
        if (!reply.ok) {
          // A caller-supplied total can overshoot what the server will
          // actually serve. Treat the past-EOF signal as completion
          // rather than failing a download that already has its bytes.
          if (reply.status === 416) break;
          throwFromReply(reply, url);
        }
        if (typeof reply.body !== 'string') {
          throw new Error(
            `proxy fetch for ${url} returned non-string body on chunk starting at ${written}`,
          );
        }
        const chunk = base64ToUint8Array(reply.body);
        // Same reasoning as the 416 above; without this an overshooting
        // total spins forever on zero-length replies.
        if (chunk.byteLength === 0) break;
        await writeChunk(chunk);
        onProgress?.(written, sizeInfo.total);
      }
      return { bytes: written };
    }

    // Unknown-total loop. Stop on 416, short chunk, or empty chunk.
    while (true) {
      signal?.throwIfAborted();
      const end = written + chunkBytes - 1;
      const reply = await proxyFetchWithRetry(
        proxyFetch,
        {
          tabId,
          frameId,
          url,
          headers: { ...(headers ?? {}), Range: `bytes=${written}-${end}` },
          responseType: 'arrayBuffer',
        },
        signal,
      );
      if (!reply.ok) {
        if (reply.status === 416) break;
        throwFromReply(reply, url);
      }
      if (typeof reply.body !== 'string') {
        throw new Error(
          `proxy fetch for ${url} returned non-string body on chunk starting at ${written}`,
        );
      }
      const chunk = base64ToUint8Array(reply.body);
      if (chunk.byteLength === 0) break;
      await writeChunk(chunk);
      onProgress?.(written, written);
      if (chunk.byteLength < chunkBytes) break;
    }
    return { bytes: written };
  } finally {
    await writable.close();
  }
}

export interface RangeSizeInfo {
  /** Best estimate of the total file size. When `known` is false this is
   *  the fallback (typically the first chunk's own byte length). */
  total: number;
  /** True when the response unambiguously declared the total size. */
  known: boolean;
}

/**
 * Derive the full content length from a partial response. Cases:
 *
 *  - `Content-Range: bytes A-B/N` with explicit numeric total →
 *    `{ total: N, known: true }`. Caller uses the pre-allocated
 *    Uint8Array path.
 *  - `Content-Range: bytes A-B/*` (server admits it doesn't know) →
 *    `{ total: fallback, known: false }`. Caller polls for EOF via
 *    short-chunk detection.
 *  - HTTP **200 OK** with no Content-Range → server didn't slice;
 *    returned the full body. `Content-Length` IS the total →
 *    `{ total: N, known: true }`.
 *  - HTTP **206 Partial Content** with Content-Range absent → on
 *    cross-origin fetches the browser strips Content-Range unless
 *    the server adds `Access-Control-Expose-Headers: Content-Range`
 *    (googlevideo doesn't). Content-Length here is the CHUNK size,
 *    not the total — must NOT be used as the total. Treat as
 *    unknown so the caller polls for EOF.
 *  - Anything else → `{ total: fallback, known: false }`.
 *
 * The previous version trusted Content-Length whenever Content-Range
 * was missing; that truncated 1080p videos at 8 MB on cross-origin
 * googlevideo fetches because the browser silently stripped
 * Content-Range and we saw Content-Length matching our request size.
 *
 * Exported for unit tests.
 */
export function parseTotalSize(
  reply: { status?: number; contentLength?: number; contentRange?: string },
  fallback: number,
): RangeSizeInfo {
  if (reply.contentRange) {
    const m = /\/(\d+)/.exec(reply.contentRange);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0) return { total: n, known: true };
    }
    return { total: fallback, known: false };
  }
  // Only treat Content-Length as the total when the server
  // explicitly returned 200 OK. A 206 response with Content-Range
  // stripped by CORS would otherwise look the same shape and we'd
  // mis-trust the chunk size as the file size.
  if (reply.status === 200 && typeof reply.contentLength === 'number' && reply.contentLength > 0) {
    return { total: reply.contentLength, known: true };
  }
  return { total: fallback, known: false };
}
