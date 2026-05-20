import { ManifestParseError, TokenExpiredError, UnsupportedFormatError } from '../lib/errors.js';
import { OpfsWorkspace } from './storage.js';
import type { DownloadProgress, DownloadResult } from './downloader.js';
import type { DownloadRequest } from '../lib/types.ts';

const OUTPUT_FILE_NAME = 'out.mp4';

/**
 * Single-URL streaming download. Used for media that's already a
 * playable MP4/WebM file — YouTube progressive itags (18, 22, 36),
 * direct MP4 embeds, etc. No manifest, no decryption, no remux.
 *
 * The body streams straight into OPFS so the JS heap doesn't carry the
 * full file. chrome.downloads reads from a File-backed Blob URL.
 *
 * Lifecycle parity with downloadHlsAsTs:
 *  - Returns `{outcome, cleanup}` — workspace stays alive past return
 *    until REVOKE_BLOB arrives.
 *  - signal threads through every async boundary; on abort the
 *    workspace is disposed and the partial file is dropped.
 */
export async function downloadProgressive(
  io: {
    onProgress: (p: DownloadProgress) => void;
    signal?: AbortSignal;
  },
  req: DownloadRequest,
): Promise<DownloadResult> {
  const { onProgress, signal } = io;
  const { requestId, variantUrl, headers, filename } = req;

  signal?.throwIfAborted();

  const workspace = await OpfsWorkspace.open(requestId);
  let succeeded = false;
  try {
    const response = await fetch(variantUrl, {
      method: 'GET',
      headers: headers ?? undefined,
      // Progressive media URLs are typically signed query-string tokens
      // not cookies, so 'omit' is the safer default. Adapters that need
      // cookies should pass them via headers.
      credentials: 'omit',
      signal,
    });
    if (!response.ok) {
      // 403 here is almost always a stale signed-token (YouTube's
      // `expire=` window passed, or Akamai/Cloudfront equivalents).
      // Surface the typed error so the popup shows the "reload the
      // page" message.
      if (response.status === 403) {
        throw new TokenExpiredError(
          `progressive download blocked by 403 (HTTP ${response.status}) — token expired`,
        );
      }
      throw new ManifestParseError(
        `progressive fetch failed (HTTP ${response.status} ${response.statusText})`,
      );
    }
    if (!response.body) {
      // fetch() spec guarantees body on a 200 with content, but Chrome
      // edge cases (HTTP/3 + zero-length responses) have produced null.
      throw new UnsupportedFormatError('progressive download: response had no body stream');
    }

    const contentLengthHeader = response.headers.get('content-length');
    const totalBytes = contentLengthHeader ? Number(contentLengthHeader) : 0;

    const outputHandle = await workspace.createOutputFile(OUTPUT_FILE_NAME);
    const writable = await outputHandle.createWritable({ keepExistingData: false });
    let downloadedBytes = 0;
    let lastProgressEmit = 0;
    try {
      const reader = response.body.getReader();
      while (true) {
        if (signal?.aborted) {
          await reader.cancel().catch(() => {});
          signal.throwIfAborted();
        }
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          // Cast: FileSystemWritableFileStream.write accepts BufferSource;
          // TS 6.0's stricter Uint8Array<ArrayBufferLike> typing trips on
          // the union without the explicit narrowing (same gotcha as
          // OpfsWorkspace.writeSegment).
          await writable.write(value as Uint8Array<ArrayBuffer>);
          downloadedBytes += value.byteLength;

          // Throttle progress to ~10/sec — emitting on every chunk
          // floods the SW with messages on fast networks.
          const now = Date.now();
          if (now - lastProgressEmit > 100 || downloadedBytes === totalBytes) {
            lastProgressEmit = now;
            const total = totalBytes > 0 ? totalBytes : downloadedBytes;
            onProgress({
              stage: 'fetch',
              current: downloadedBytes,
              total,
              segmentCurrent: 0,
              segmentTotal: 0,
            });
          }
        }
      }
    } catch (err) {
      await writable.abort().catch(() => {});
      throw err;
    }
    await writable.close();

    // Final progress emit — guarantees the bar lands at 100% even when
    // the throttle suppressed the last in-loop tick.
    onProgress({
      stage: 'fetch',
      current: downloadedBytes,
      total: downloadedBytes,
      segmentCurrent: 0,
      segmentTotal: 0,
    });

    const outputFile = await workspace.getOutputFile(OUTPUT_FILE_NAME);
    const blobUrl = URL.createObjectURL(outputFile);
    succeeded = true;
    return {
      outcome: {
        requestId,
        blobUrl,
        filename: `${filename}.mp4`,
        bytes: downloadedBytes,
        // Progressive has one logical "segment" — the whole file. The
        // popup labels this stage as "fetching" and never advances to
        // decrypt/remux, which matches reality.
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
