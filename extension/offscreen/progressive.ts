import { log, redactUrl } from '../lib/log.js';
import { fetchArrayBuffer, type ProxyFetch } from './downloader.js';
import { OpfsWorkspace } from './storage.js';
import type { DownloadProgress, DownloadResult } from './downloader.js';
import type { DownloadRequest } from '../lib/types.ts';

const OUTPUT_FILE_NAME = 'out.mp4';

/**
 * Single-URL download routed through the content-script proxy. Used for
 * media that's already a playable MP4/WebM file — YouTube progressive
 * itags (18, 22, 36), direct MP4 embeds, etc. No manifest, no
 * decryption, no remux.
 *
 * Why proxyFetch instead of a direct `fetch()` from the offscreen?
 * Signed-URL CDNs (Hotmart's `hdntl`, YouTube's googlevideo) often
 * validate the request's Origin/Referer. A `chrome-extension://...`
 * origin from the offscreen document tends to 403; the same URL fetched
 * from the player's tab (`https://www.youtube.com`) succeeds. The HLS
 * pipeline learned this in v0.6 — see AGENTS.md §15. Progressive
 * downloads go through the same proxy so the request originates from
 * the page's content script.
 *
 * Lifecycle parity with downloadHlsAsTs:
 *  - Returns `{outcome, cleanup}` — workspace stays alive past return
 *    until REVOKE_BLOB arrives.
 *  - signal threads through every async boundary; on abort the
 *    workspace is disposed and the partial file is dropped.
 *
 * Memory: progressive routes through the proxy's base64-encoded reply
 * which peaks at ~2× the file size briefly during decode. For
 * itag=18/22 YouTube videos (typically 5–50 MB) this is acceptable.
 * Larger progressive sources (long-form direct MP4 embeds) will want a
 * Range-based chunked proxy in a follow-up — the structure here makes
 * that an easy swap.
 */
export async function downloadProgressive(
  io: {
    proxyFetch: ProxyFetch;
    onProgress: (p: DownloadProgress) => void;
    signal?: AbortSignal;
  },
  req: DownloadRequest,
): Promise<DownloadResult> {
  const { proxyFetch, onProgress, signal } = io;
  const { requestId, variantUrl, tabId, frameId, headers, filename } = req;

  signal?.throwIfAborted();

  const workspace = await OpfsWorkspace.open(requestId);
  let succeeded = false;
  try {
    // Single fetch — the whole file lands in one ArrayBuffer. Emit a
    // 0% tick so the popup shows the "fetching" stage immediately
    // (the proxy fetch can take seconds before bytes arrive).
    onProgress({
      stage: 'fetch',
      current: 0,
      total: 1,
      segmentCurrent: 0,
      segmentTotal: 1,
    });

    // Range: bytes=0- is what the YouTube player uses internally;
    // googlevideo's CDN sometimes rejects naked GETs for video URLs.
    // Merged with any adapter-supplied headers (none for YouTube
    // today, but Hotmart-like adapters could set Authorization).
    const mergedHeaders: Record<string, string> = {
      Range: 'bytes=0-',
      ...(headers ?? {}),
    };

    let bytes: Uint8Array;
    try {
      bytes = await fetchArrayBuffer(proxyFetch, {
        tabId,
        frameId,
        url: variantUrl,
        headers: mergedHeaders,
        signal,
      });
    } catch (err) {
      // Surface the URL on failure so the user can manually retry it
      // and compare against the SW's error. Redacts signing params.
      log.warn('progressive fetch failed', {
        requestId,
        url: redactUrl(variantUrl),
        err: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    signal?.throwIfAborted();

    const outputHandle = await workspace.createOutputFile(OUTPUT_FILE_NAME);
    const writable = await outputHandle.createWritable({ keepExistingData: false });
    try {
      // Cast: createWritable.write accepts BufferSource; TS 6.0's
      // stricter Uint8Array<ArrayBufferLike> typing trips on the
      // union without the explicit narrowing (same gotcha as
      // OpfsWorkspace.writeSegment).
      await writable.write(bytes as Uint8Array<ArrayBuffer>);
    } catch (err) {
      await writable.abort().catch(() => {});
      throw err;
    }
    await writable.close();

    onProgress({
      stage: 'fetch',
      current: bytes.byteLength,
      total: bytes.byteLength,
      segmentCurrent: 1,
      segmentTotal: 1,
    });

    const outputFile = await workspace.getOutputFile(OUTPUT_FILE_NAME);
    const blobUrl = URL.createObjectURL(outputFile);
    succeeded = true;
    return {
      outcome: {
        requestId,
        blobUrl,
        filename: `${filename}.mp4`,
        bytes: bytes.byteLength,
        // Progressive has one logical "segment" — the whole file.
        segments: 1,
      },
      cleanup: () => workspace.dispose(),
    };
  } finally {
    if (!succeeded) {
      await workspace.dispose();
    }
  }
}
