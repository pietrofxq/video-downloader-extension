// Adaptive (DASH-style) two-stream download path (v0.11.1).
//
// YouTube's higher-quality formats (1080p+ AVC, all VP9 / AV1) are
// served as separate video-only and audio-only fMP4 URLs under
// `googlevideo.com/videoplayback?...`. The popup picks a video
// variant; the SW carries its `pairedAudioUrl` forward, and we land
// here when `req.kind === 'dash'`.
//
// Pipeline:
//   1. Decipher both URLs through the YouTube solver (n + signature).
//   2. Fetch both fMP4 streams in parallel through the content-script
//      proxy. Same Origin/Referer rules apply as in the progressive
//      path — googlevideo 403s offscreen-originated fetches.
//   3. Hand both buffers to `combineFmp4`, which writes the merged
//      MP4 directly to OPFS via the v0.10 workspace.
//   4. Return a Blob URL backed by the OPFS file; the SW hands it to
//      chrome.downloads.download.
//
// KNOWN LIMIT (v0.11.1): each stream is fetched in one shot through
// the content-script proxy. The proxy reply carries the body as a
// base64-encoded string over `chrome.runtime.sendMessage`, so the
// peak transit footprint is roughly 2× the file size — the encoded
// reply traveling from content script → SW → offscreen, plus the
// decoded buffer once it lands here. Chrome's message bus has a
// practical cap in the tens-to-low-hundreds of megabytes; a 1080p
// AVC video at ~4 Mbps × 10 min is right at that edge.
//
// Once we hit that wall on a real video, the fix is the chunked /
// Range-based proxy already on the v1.3 progressive-download
// roadmap: fetch the body in slices and append them to OPFS without
// ever materializing the whole buffer in JS heap. Holding off on it
// for v0.11.1 to keep the change surface bounded.

import { UnsupportedFormatError } from '../lib/errors.js';
import { log, redactUrl } from '../lib/log.js';
import { type ProxyFetch } from './downloader.js';
import { fetchArrayBufferRanged } from './range-fetch.js';
import { combineFmp4 } from './mp4-combine.js';
import { OpfsWorkspace } from './storage.js';
import { getYouTubeSolver } from './yt-sig.js';
import type { DownloadProgress, DownloadResult } from './downloader.js';
import type { DownloadRequest } from '../lib/types.ts';

const OUTPUT_FILE_NAME = 'out.mp4';

function isYouTubeMediaUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'googlevideo.com' || host.endsWith('.googlevideo.com');
  } catch {
    return false;
  }
}

export async function downloadAdaptive(
  io: {
    proxyFetch: ProxyFetch;
    onProgress: (p: DownloadProgress) => void;
    signal?: AbortSignal;
  },
  req: DownloadRequest,
): Promise<DownloadResult> {
  const { proxyFetch, onProgress, signal } = io;
  const { requestId, variantUrl, tabId, frameId, headers, filename } = req;

  // Entry trace so the offscreen console proves the adaptive path is
  // actually being hit (vs. a missed dispatch / hanging RUN_DOWNLOAD).
  log.info('downloadAdaptive: enter', {
    requestId,
    tabId,
    frameId,
    variantUrl: redactUrl(variantUrl),
    pairedAudioUrl: redactUrl(req.pairedAudioUrl),
    hasSignatureCipher: !!req.signatureCipher,
    hasPairedSignatureCipher: !!req.pairedSignatureCipher,
  });

  signal?.throwIfAborted();

  if (!req.pairedAudioUrl) {
    // YouTube adaptive variants always come with a paired audio URL
    // from the adapter (or are filtered out before this point). HLS
    // alternate-audio support is the v0.12 milestone and uses a
    // different code path.
    throw new UnsupportedFormatError(
      'Adaptive download requires a paired audio stream; none was supplied.',
    );
  }

  // ---- Step 1: decipher both URLs. ----
  //
  // YouTube solver short-circuits when no n / signature is present, so
  // running it on a non-YouTube URL would still work but be wasteful.
  // We gate on host to skip the iframe_api round-trip for HLS-equivalent
  // adaptive sources (none today, but the type signature admits them).
  let videoUrl = variantUrl;
  let audioUrl = req.pairedAudioUrl;
  if (isYouTubeMediaUrl(variantUrl) || isYouTubeMediaUrl(req.pairedAudioUrl)) {
    log.info('downloadAdaptive: starting decipher', { requestId });
    try {
      const solver = await getYouTubeSolver({ proxyFetch, tabId, frameId, signal });
      log.info('downloadAdaptive: solver ready', { requestId });
      videoUrl = req.signatureCipher
        ? await solver.decipher({ signatureCipher: req.signatureCipher })
        : await solver.decipher(variantUrl);
      log.info('downloadAdaptive: video URL deciphered', {
        requestId,
        videoUrl: redactUrl(videoUrl),
      });
      audioUrl = req.pairedSignatureCipher
        ? await solver.decipher({ signatureCipher: req.pairedSignatureCipher })
        : await solver.decipher(req.pairedAudioUrl);
      log.info('downloadAdaptive: audio URL deciphered', {
        requestId,
        audioUrl: redactUrl(audioUrl),
      });
    } catch (err) {
      log.warn('yt-sig: solver setup failed for adaptive download', {
        requestId,
        err: err instanceof Error ? err.message : String(err),
      });
      // Continue with the un-transformed URLs — the proxy fetch will
      // surface a clean 403 if the CDN rejects them.
    }
  }

  signal?.throwIfAborted();

  // ---- Step 2: fetch both streams. ----
  //
  // Unified progress model so the popup's bar doesn't regress when
  // the pipeline transitions from fetch to remux. We map the whole
  // download onto a virtual 0..100 scale:
  //   - Fetch phase contributes 0..80 (network is the slow part).
  //   - Remux phase contributes 80..100 (a single bytes-copy pass).
  // Phase contributions accumulate; once `fetchProgressBytes` is at
  // its max, it never decreases.
  //
  // During fetch the total file size is unknown (CORS strips
  // Content-Range on cross-origin googlevideo responses), so the
  // fetch portion approaches but doesn't quite reach 80% — it uses
  // an asymptotic estimate `fetched / (fetched + ESTIMATED_MORE)`
  // that climbs as bytes land. When fetch completes we snap to 80%
  // exactly; remux then takes us to 100%.
  const FETCH_PORTION = 80;
  const REMUX_PORTION = 20;
  const ESTIMATED_MORE_BYTES = 16 * 1024 * 1024; // two more 8 MB chunks (video + audio)
  let videoBytesFetched = 0;
  let audioBytesFetched = 0;
  let fetchTotalAtCompletion = 0; // 0 while fetching; set when both sides finish
  let remuxBytesWritten = 0;
  let remuxBytesTotal = 0;

  function emit(stage: DownloadProgress['stage']): void {
    const fetched = videoBytesFetched + audioBytesFetched;
    let virtualCurrent: number;
    let segmentCurrent: number;
    let segmentTotal: number;
    if (fetchTotalAtCompletion === 0) {
      // Still fetching. Use the asymptotic estimate.
      virtualCurrent =
        fetched > 0 ? (FETCH_PORTION * fetched) / (fetched + ESTIMATED_MORE_BYTES) : 0;
      segmentCurrent = fetched;
      segmentTotal = fetched + ESTIMATED_MORE_BYTES;
    } else if (remuxBytesTotal === 0 || stage === 'fetch') {
      // Fetch fully complete, remux not yet started. Snap to the
      // fetch portion's full value (80%).
      virtualCurrent = FETCH_PORTION;
      segmentCurrent = fetched;
      segmentTotal = fetched;
    } else {
      // Remux running: linear interpolate inside the remux portion.
      const remuxFrac = Math.min(1, remuxBytesWritten / remuxBytesTotal);
      virtualCurrent = FETCH_PORTION + REMUX_PORTION * remuxFrac;
      segmentCurrent = remuxBytesWritten;
      segmentTotal = remuxBytesTotal;
    }
    onProgress({
      stage,
      current: Math.round(virtualCurrent),
      total: FETCH_PORTION + REMUX_PORTION,
      segmentCurrent,
      segmentTotal,
    });
  }

  const mergedHeaders: Record<string, string> = {
    Range: 'bytes=0-',
    ...(headers ?? {}),
  };
  // Early 0% tick so the popup row shows the fetching stage before
  // the first byte arrives — these requests can take seconds.
  emit('fetch');

  const workspace = await OpfsWorkspace.open(requestId);
  let succeeded = false;
  try {
    log.info('downloadAdaptive: starting parallel fetch', { requestId });
    // Parallel fetch — the slower of the two gates the start of remux.
    // v0.11.3: each side runs through fetchArrayBufferRanged, which
    // issues `Range: bytes=A-B` requests in 8 MB chunks so a single
    // base64 transit never exceeds chrome.runtime.sendMessage's
    // practical cap.
    //
    // Each side updates its own byte counter; the unified `emit`
    // closure then combines them so video + audio progress is
    // surfaced together (vs. the old per-side onProgress that
    // overwrote one another on the popup's progress bar).
    const fetchSide = async (side: 'video' | 'audio', url: string): Promise<Uint8Array> => {
      log.info(`downloadAdaptive: fetch ${side} start`, {
        requestId,
        url: redactUrl(url),
      });
      const bytes = await fetchArrayBufferRanged({
        proxyFetch,
        tabId,
        frameId,
        url,
        headers: mergedHeaders,
        signal,
        onProgress: (written) => {
          if (side === 'video') videoBytesFetched = written;
          else audioBytesFetched = written;
          emit('fetch');
        },
      });
      log.info(`downloadAdaptive: fetch ${side} done`, {
        requestId,
        bytes: bytes.byteLength,
      });
      return bytes;
    };
    const [videoBytes, audioBytes] = await Promise.all([
      fetchSide('video', videoUrl),
      fetchSide('audio', audioUrl),
    ]).catch((err: unknown) => {
      log.warn('adaptive fetch failed', {
        requestId,
        video: redactUrl(videoUrl),
        audio: redactUrl(audioUrl),
        err: err instanceof Error ? err.message : String(err),
      });
      throw err;
    });

    signal?.throwIfAborted();

    // Fetch complete — pin the unified bar to FETCH_PORTION before
    // remux starts so the next transition is a smooth climb rather
    // than a snap-to-low-percent.
    videoBytesFetched = videoBytes.byteLength;
    audioBytesFetched = audioBytes.byteLength;
    fetchTotalAtCompletion = videoBytesFetched + audioBytesFetched;
    emit('fetch');

    // ---- Step 3: combine fMP4 streams into one MP4 written to OPFS. ----
    //
    // Progress here is bytes-based — combineFmp4 emits (written / total)
    // as it writes. We map it onto the 'remux' stage so the popup's
    // unified-progress bar advances naturally past the fetch phase.
    log.info('downloadAdaptive: starting combineFmp4', {
      requestId,
      videoBytes: videoBytes.byteLength,
      audioBytes: audioBytes.byteLength,
    });
    const outputHandle = await workspace.createOutputFile(OUTPUT_FILE_NAME);
    const combined = await combineFmp4(
      videoBytes,
      audioBytes,
      outputHandle,
      (p) => {
        remuxBytesWritten = p.written;
        remuxBytesTotal = p.total;
        emit('remux');
      },
      signal,
    );

    signal?.throwIfAborted();

    // ---- Step 4: blob URL handoff. ----
    const outputFile = await workspace.getOutputFile(OUTPUT_FILE_NAME);
    const blobUrl = URL.createObjectURL(outputFile);
    succeeded = true;
    return {
      outcome: {
        requestId,
        blobUrl,
        filename: `${filename}.mp4`,
        bytes: combined.bytes,
        // Two logical "segments" (video + audio) — surfaced for the
        // popup label even though the remux is a single bytes-pass.
        segments: 2,
      },
      cleanup: () => workspace.dispose(),
    };
  } finally {
    if (!succeeded) {
      await workspace.dispose();
    }
  }
}
