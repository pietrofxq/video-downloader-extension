import { log, redactUrl } from '../lib/log.js';
import { fetchArrayBuffer, type ProxyFetch } from './downloader.js';
import { OpfsWorkspace } from './storage.js';
import { getYouTubeSolver } from './yt-sig.js';
import type { DownloadProgress, DownloadResult } from './downloader.js';
import type { DownloadRequest } from '../lib/types.ts';

function isYouTubeMediaUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'googlevideo.com' || host.endsWith('.googlevideo.com');
  } catch {
    return false;
  }
}

/**
 * Pick the output file extension for the saved file. Progressive
 * downloads pass the source bytes through unchanged — we don't remux —
 * so the on-disk filename must match the actual container or the
 * user's media player won't recognize the file.
 *
 * Priority:
 *   1. YouTube videoplayback URLs declare `mime=...` (video/mp4,
 *      video/webm, video/3gpp). Use that.
 *   2. Generic progressive sources put the format in the URL path
 *      (e.g. `.mp4`, `.webm`). Use the last path segment's extension
 *      if it's one we recognize as a video container.
 *   3. Fall back to `mp4` (the most common shape, and what every
 *      itag the v0.11 path actually serves uses).
 *
 * Exported for unit tests.
 */
export function deriveProgressiveExtension(url: string): string {
  try {
    const u = new URL(url);
    const mime = u.searchParams.get('mime');
    if (mime) {
      if (mime.startsWith('video/mp4')) return 'mp4';
      if (mime.startsWith('video/webm')) return 'webm';
      if (mime.startsWith('video/3gpp')) return '3gp';
    }
    const last = u.pathname.split('/').filter(Boolean).pop() ?? '';
    const dot = last.lastIndexOf('.');
    if (dot > 0) {
      const ext = last.slice(dot + 1).toLowerCase();
      if (ext === 'mp4' || ext === 'webm' || ext === '3gp' || ext === 'm4v') {
        return ext === 'm4v' ? 'mp4' : ext;
      }
    }
  } catch {
    // fall through
  }
  return 'mp4';
}

// OPFS staging filename — the actual container doesn't matter here
// because the saved-to-disk name (and what chrome.downloads sees) is
// driven by the outcome.filename below, not this on-disk path.
const OUTPUT_FILE_NAME = 'out.bin';

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

  // YouTube URL signing. The signed `n=...` value on a videoplayback
  // URL must be re-signed by a function from base.js or the CDN 403s
  // the request. We detect googlevideo URLs by hostname and
  // auto-discover the player JS via iframe_api (see yt-sig.ts —
  // mirrors LuanRT/YouTube.js's approach). Non-YouTube progressive
  // sources skip this entire step.
  let fetchUrl = variantUrl;
  if (isYouTubeMediaUrl(variantUrl)) {
    try {
      const solver = await getYouTubeSolver({ proxyFetch, tabId, frameId, signal });
      fetchUrl = await solver.decipher(variantUrl);
    } catch (err) {
      log.warn('yt-sig: solver setup failed; proceeding with original URL', {
        requestId,
        url: redactUrl(variantUrl),
        err: err instanceof Error ? err.message : String(err),
      });
      // Fall through with the un-transformed URL — better to fail
      // with a clean 403 than to silently abort the download.
    }
  }

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
        url: fetchUrl,
        headers: mergedHeaders,
        signal,
      });
    } catch (err) {
      // Surface the URL on failure so the user can manually retry it
      // and compare against the SW's error. Redacts signing params.
      log.warn('progressive fetch failed', {
        requestId,
        url: redactUrl(fetchUrl),
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
    const ext = deriveProgressiveExtension(variantUrl);
    succeeded = true;
    return {
      outcome: {
        requestId,
        blobUrl,
        filename: `${filename}.${ext}`,
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
