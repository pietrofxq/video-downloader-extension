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
// Peak JS heap (v0.11.5): bounded by the muxer's mdat-copy chunk
// size (1 MB per side) plus each input's moov (typically tens of
// KB). The full video and audio streams are staged to OPFS during
// fetch via `fetchToOpfsRanged` and read on-demand by the combine
// pass — no materialization of the full file in heap on either
// side. Required for 4K (1-3 GB per side).

import { InsufficientStorageError, UnsupportedFormatError } from '../lib/errors.js';
import { log, redactUrl } from '../lib/log.js';
import { type ProxyFetch } from './downloader.js';
import { fetchToOpfsRanged } from './range-fetch.js';
import { combineFmp4, fileSource } from './mp4-combine.js';
import { OpfsWorkspace } from './storage.js';
import { getYouTubeSolver } from './yt-sig.js';
import type { DownloadProgress, DownloadResult } from './downloader.js';
import type { DownloadRequest } from '../lib/types.ts';

const OUTPUT_FILE_NAME = 'out.mp4';
const VIDEO_STAGE_FILE = 'video.in';
const AUDIO_STAGE_FILE = 'audio.in';

/**
 * Declared byte length of a googlevideo stream, read from the URL's
 * `clen` param. Present on every adaptive URL YouTube hands out, and it
 * survives the signature/n rewrite, so it is a more reliable total than
 * anything the response headers expose — CORS strips `Content-Range`
 * cross-origin.
 *
 * Exported for unit tests.
 */
export function contentLengthFromUrl(url: string): number | undefined {
  try {
    const raw = new URL(url).searchParams.get('clen');
    if (!raw) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Refuse up-front when the staged download cannot fit.
 *
 * The adaptive path writes both input streams to OPFS and then the
 * combined output alongside them, so peak usage is roughly twice the
 * summed input size — a 2h44m 4K stream is ~8 GB of video, so ~17 GB of
 * quota. Hitting that limit mid-write fails gigabytes and many minutes
 * in, which reads as a hang; checking first turns it into an immediate,
 * actionable message.
 *
 * Silent when the total is unknown or the platform doesn't implement
 * `storage.estimate` — never block a download on a missing estimate.
 */
async function assertStorageHeadroom(totalInputBytes: number, requestId: string): Promise<void> {
  if (totalInputBytes <= 0) return;
  let estimate: StorageEstimate | undefined;
  try {
    estimate = await navigator.storage?.estimate?.();
  } catch {
    return;
  }
  const quota = estimate?.quota;
  if (typeof quota !== 'number' || quota <= 0) return;
  const available = quota - (estimate?.usage ?? 0);
  const needed = totalInputBytes * 2;
  log.info('downloadAdaptive: storage preflight', {
    requestId,
    neededMB: Math.round(needed / 1048576),
    availableMB: Math.round(available / 1048576),
  });
  if (available >= needed) return;
  const gb = (n: number): string => (n / 1073741824).toFixed(1);
  throw new InsufficientStorageError(
    `needs about ${gb(needed)} GB of browser storage to stage this download but only ${gb(available)} GB is free`,
  );
}

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
    discoverySource: req.discoverySource ?? 'unknown',
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
  // Real totals when the platform declares them. The asymptotic
  // estimate below is only a fallback now: it assumes ~16 MB remain, so
  // on a multi-GB download it pins the bar near the top of the fetch
  // portion and leaves it there for gigabytes. That is what "stuck at
  // 79%" was — the fetch was still running with hours of bytes to go.
  const videoTotalBytes = contentLengthFromUrl(videoUrl) ?? req.variantContentLength;
  const audioTotalBytes = contentLengthFromUrl(audioUrl) ?? req.pairedAudioContentLength;
  const fetchTotalBytes =
    videoTotalBytes && audioTotalBytes ? videoTotalBytes + audioTotalBytes : 0;
  log.info('downloadAdaptive: fetch totals', {
    requestId,
    videoMB: videoTotalBytes ? Math.round(videoTotalBytes / 1048576) : null,
    audioMB: audioTotalBytes ? Math.round(audioTotalBytes / 1048576) : null,
    knownTotal: fetchTotalBytes > 0,
  });

  await assertStorageHeadroom(fetchTotalBytes, requestId);

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
    if (fetchTotalAtCompletion === 0 && fetchTotalBytes > 0) {
      // Real denominator — the bar tracks actual bytes for the whole
      // fetch, however large.
      virtualCurrent = FETCH_PORTION * Math.min(1, fetched / fetchTotalBytes);
      segmentCurrent = fetched;
      segmentTotal = fetchTotalBytes;
    } else if (fetchTotalAtCompletion === 0) {
      // Fallback for sources that declare no length. Known to saturate
      // on large files; see the note where fetchTotalBytes is computed.
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
    // Parallel fetch, OPFS-staged. Each side streams to its own
    // workspace file via `fetchToOpfsRanged`; peak JS heap during
    // fetch is one chunk per side (~8 MB) regardless of stream size.
    // The combine pass later reads them on-demand via `fileSource`.
    const videoStageHandle = await workspace.createOutputFile(VIDEO_STAGE_FILE);
    const audioStageHandle = await workspace.createOutputFile(AUDIO_STAGE_FILE);
    const fetchSide = async (
      side: 'video' | 'audio',
      url: string,
      handle: FileSystemFileHandle,
    ): Promise<number> => {
      log.info(`downloadAdaptive: fetch ${side} start`, {
        requestId,
        url: redactUrl(url),
      });
      const { bytes } = await fetchToOpfsRanged({
        proxyFetch,
        tabId,
        frameId,
        url,
        headers: mergedHeaders,
        signal,
        outputHandle: handle,
        ...(side === 'video'
          ? videoTotalBytes
            ? { knownTotalBytes: videoTotalBytes }
            : {}
          : audioTotalBytes
            ? { knownTotalBytes: audioTotalBytes }
            : {}),
        onProgress: (written) => {
          if (side === 'video') videoBytesFetched = written;
          else audioBytesFetched = written;
          emit('fetch');
        },
      });
      log.info(`downloadAdaptive: fetch ${side} done`, { requestId, bytes });
      return bytes;
    };
    const [videoBytesLen, audioBytesLen] = await Promise.all([
      fetchSide('video', videoUrl, videoStageHandle),
      fetchSide('audio', audioUrl, audioStageHandle),
    ]).catch((err: unknown) => {
      log.warn('adaptive fetch failed', {
        requestId,
        video: redactUrl(videoUrl),
        audio: redactUrl(audioUrl),
        discoverySource: req.discoverySource ?? 'unknown',
        err: err instanceof Error ? err.message : String(err),
      });
      throw err;
    });

    signal?.throwIfAborted();

    // Fetch complete — pin the unified bar to FETCH_PORTION before
    // remux starts so the next transition is a smooth climb rather
    // than a snap-to-low-percent.
    videoBytesFetched = videoBytesLen;
    audioBytesFetched = audioBytesLen;
    fetchTotalAtCompletion = videoBytesFetched + audioBytesFetched;
    emit('fetch');

    // ---- Step 3: combine fMP4 streams into one MP4 written to OPFS. ----
    //
    // Both inputs are now staged in OPFS. Wrap each as an Fmp4Source
    // backed by File.slice() — the combine pass reads moofs in full
    // (small) and stream-copies mdat ranges in 1 MB chunks, so peak
    // JS heap during remux stays around a couple MB total no matter
    // how large the inputs are.
    log.info('downloadAdaptive: starting combineFmp4', {
      requestId,
      videoBytes: videoBytesLen,
      audioBytes: audioBytesLen,
    });
    const videoStageFile = await workspace.getOutputFile(VIDEO_STAGE_FILE);
    const audioStageFile = await workspace.getOutputFile(AUDIO_STAGE_FILE);
    const outputHandle = await workspace.createOutputFile(OUTPUT_FILE_NAME);
    const combined = await combineFmp4(
      fileSource(videoStageFile),
      fileSource(audioStageFile),
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
