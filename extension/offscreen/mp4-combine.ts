// fMP4 two-track combine muxer (v0.11.1).
//
// Takes two single-track fragmented-MP4 byte streams (video + audio) and
// produces one fMP4 with both tracks. The inputs come from YouTube's
// adaptive `videoplayback?...` URLs — each one is already a well-formed
// fMP4 in the shape:
//
//   ftyp
//   moov  (mvhd + one trak)
//   sidx? (segment index — optional, dropped on combine)
//   (moof + mdat)+
//
// Unlike `remux.ts`, we don't need to patch per-fragment tfdt or
// promote signed cto — googlevideo serves correctly-formed fragments.
// We do still patch the combined mvhd.duration because generic DASH
// packagers (and some YouTube responses) leave the init segment's
// movie duration at 0 or the 0xFFFFFFFF "unknown" sentinel. The work
// here is:
//
//   1. Parse the structure of each input (top-level box offsets).
//   2. Build a combined moov:
//        - mvhd from the video (with duration = max(video,audio) in
//          movie timescale, and next_track_ID bumped to 3)
//        - the video's <trak> verbatim (track_ID stays at 1)
//        - the audio's <trak> with track_ID renumbered to 2 (we patch
//          tkhd + every audio moof's tfhd to match)
//   3. Emit interleaved (moof + mdat) pairs from both inputs in tfdt
//      time order, assigning monotonic mfhd.sequence_number across the
//      whole stream. Audio moofs get tfhd.track_ID patched to 2.
//
// Why interleave rather than concatenate? VLC + QuickTime play either,
// but interleaved playback gives the player local access to both
// streams during seek without scanning past the end of the video data.

import { RemuxError } from '../lib/errors.js';

// ---------- public API ----------

/**
 * Read-only byte source the muxer pulls from. Implemented by
 * `memorySource(Uint8Array)` for in-process buffers and tests, and by
 * `fileSource(File)` for OPFS-staged inputs (the v0.11.5 4K path —
 * fetching to memory would peak at 1-3 GB per side).
 *
 * `read(offset, length)` returns the bytes at `[offset, offset+length)`
 * — implementations may return a view (no copy) when cheaper.
 */
export interface Fmp4Source {
  byteLength: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

/** Wrap an in-memory buffer as a source. Reads return subarray views. */
export function memorySource(buf: Uint8Array): Fmp4Source {
  return {
    byteLength: buf.byteLength,
    async read(offset, length): Promise<Uint8Array> {
      return buf.subarray(offset, offset + length);
    },
  };
}

/** Wrap an OPFS-staged `File` as a source. Reads slice + arrayBuffer. */
export function fileSource(file: File): Fmp4Source {
  return {
    byteLength: file.size,
    async read(offset, length): Promise<Uint8Array> {
      const slice = file.slice(offset, offset + length);
      return new Uint8Array(await slice.arrayBuffer());
    },
  };
}

export interface CombineProgress {
  /** Bytes written to the OPFS output so far. */
  written: number;
  /** Total bytes that will be written (sum of inputs minus dropped sidx). */
  total: number;
}

/**
 * Chunk size for streaming mdat → output copies. Caps peak JS heap
 * during the combine pass at 2 × this (one chunk per side). Picked
 * for 4K (mdat ranges can be hundreds of MB).
 */
const MDAT_COPY_CHUNK_BYTES = 1 * 1024 * 1024;

/**
 * Combine the two fMP4 byte streams into a single MP4 written to
 * `outputHandle`. The output is fully written before this resolves; the
 * caller turns the file handle into a Blob URL afterward.
 *
 * Memory footprint is bounded by the moov sizes (tens to hundreds of
 * KB combined) + one mdat-copy chunk per side (1 MB each). The full
 * input video / audio bytes never live in JS heap simultaneously —
 * that's the v0.11.5 4K refactor's load-bearing change.
 *
 * @returns total bytes written to the output file.
 */
export async function combineFmp4(
  video: Fmp4Source,
  audio: Fmp4Source,
  outputHandle: FileSystemFileHandle,
  onProgress?: (p: CombineProgress) => void,
  signal?: AbortSignal,
): Promise<{ bytes: number }> {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('aborted', 'AbortError');
  }

  const videoParsed = await parseFmp4Structure(video);
  const audioParsed = await parseFmp4Structure(audio);

  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('aborted', 'AbortError');
  }

  // Track-ID assignment: video keeps whatever it has (typically 1),
  // audio gets renumbered to a value distinct from the video's. We
  // grab the actual video track_ID from its trak rather than assume 1,
  // because some YouTube responses use other IDs for the single track.
  const videoTrackId = readTrackIdFromTrak(videoParsed.moovBytes, videoParsed.trakRange);
  let audioTargetTrackId = videoTrackId === 1 ? 2 : 1;
  if (audioTargetTrackId === videoTrackId) audioTargetTrackId += 1;

  // Build the combined moov in memory. fMP4 moov is small (tens of KB
  // even for long videos — the per-sample tables live in the trun
  // boxes inside each moof, not in stsz/stco like a fully-packed MP4).
  const moov = buildCombinedMoov({
    videoParsed,
    audioParsed,
    audioNewTrackId: audioTargetTrackId,
  });

  // Collect every (moof, mdat) pair from both inputs, tagged with its
  // tfdt time in seconds and the source side. Interleave by time.
  const [videoFrags, audioFrags] = await Promise.all([
    collectFragments(videoParsed, video, 'video'),
    collectFragments(audioParsed, audio, 'audio'),
  ]);
  const fragments = [...videoFrags, ...audioFrags];
  fragments.sort((a, b) => {
    if (a.tfdtSeconds !== b.tfdtSeconds) return a.tfdtSeconds - b.tfdtSeconds;
    // Ties: video first — gives the player the keyframe before audio.
    if (a.side !== b.side) return a.side === 'video' ? -1 : 1;
    return 0;
  });

  // Compute the total output size up-front so progress can be a real
  // fraction. ftyp + moov + sum(moof+mdat).
  const ftyp = videoParsed.ftypBytes;
  let totalBytes = ftyp.byteLength + moov.byteLength;
  for (const frag of fragments) totalBytes += frag.totalBytes;

  const writable = await outputHandle.createWritable({ keepExistingData: false });
  let written = 0;
  const writeChunk = async (chunk: Uint8Array): Promise<void> => {
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException('aborted', 'AbortError');
    }
    await writable.write(chunk as Uint8Array<ArrayBuffer>);
    written += chunk.byteLength;
    onProgress?.({ written, total: totalBytes });
  };

  try {
    await writeChunk(ftyp);
    await writeChunk(moov);

    let sequenceNumber = 1;
    for (const frag of fragments) {
      if (signal?.aborted) {
        throw signal.reason ?? new DOMException('aborted', 'AbortError');
      }
      // Read the moof body into JS heap so we can patch mfhd / tfhd
      // in place. moofs are small (tens of KB). The mdat is streamed
      // directly source → output without ever materializing in heap.
      const moofBytes = await frag.source.read(
        frag.moofRange.start,
        frag.moofRange.end - frag.moofRange.start,
      );
      const moofMut = moofBytes instanceof Uint8Array ? new Uint8Array(moofBytes) : moofBytes;
      patchMfhdSequence(moofMut, sequenceNumber);
      sequenceNumber += 1;
      if (frag.side === 'audio') {
        patchAllTfhdTrackIds(moofMut, audioTargetTrackId);
      }
      await writeChunk(moofMut);
      await copyRange(
        frag.source,
        frag.mdatRange.start,
        frag.mdatRange.end - frag.mdatRange.start,
        writeChunk,
        signal,
      );
    }
  } finally {
    await writable.close();
  }
  return { bytes: written };
}

/**
 * Stream a byte range from a source to the write callback in chunks
 * of up to `MDAT_COPY_CHUNK_BYTES`. Peak JS heap is one chunk. Used
 * for mdat bodies, which at 4K can be hundreds of MB — slicing the
 * full range would OOM the offscreen document.
 */
async function copyRange(
  source: Fmp4Source,
  offset: number,
  length: number,
  writeChunk: (b: Uint8Array) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  let copied = 0;
  while (copied < length) {
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException('aborted', 'AbortError');
    }
    const take = Math.min(MDAT_COPY_CHUNK_BYTES, length - copied);
    const chunk = await source.read(offset + copied, take);
    await writeChunk(chunk);
    copied += chunk.byteLength;
    if (chunk.byteLength === 0) {
      // Defensive: a 0-byte read with `take > 0` means the source
      // truncated. Rather than spinning, fail loud.
      throw new RemuxError(
        `mp4-combine: source returned 0 bytes mid-copy at offset ${offset + copied}`,
      );
    }
  }
}

// ---------- structure parsing ----------

interface Range {
  start: number;
  end: number;
}

interface ParsedFmp4 {
  /** Bytes of the source's ftyp (small — read in full during parse). */
  ftypBytes: Uint8Array;
  /** Bytes of the source's moov (small — read in full during parse). */
  moovBytes: Uint8Array;
  /** Range of the single <trak> within `moovBytes`. */
  trakRange: Range;
  /** mvhd box range within `moovBytes`. */
  mvhdRange: Range;
  /** Total playback duration in seconds (read from mvhd or derived from fragments). */
  durationSeconds: number;
  /** Movie timescale (from mvhd). */
  movieTimescale: number;
  /** Track's own timescale (from mdhd inside mdia inside trak). */
  trackTimescale: number;
  /** (moof, mdat) pairs as absolute file offsets in the source. */
  fragments: Array<{ moofRange: Range; mdatRange: Range }>;
}

/**
 * Walk top-level boxes from the source. Reads ONLY the 16 bytes
 * needed for each header (8 for normal, +8 if size==1 largesize)
 * instead of pulling a full chunk per box — the body lives on
 * disk in the streaming case, so reading it here is wasted I/O.
 *
 * The bounds check in `readBoxHeader` rejects boxes whose
 * totalSize exceeds the buffer we pass in — that's the right
 * behavior when the buffer IS the whole file (in-memory case)
 * but wrong here because we deliberately only buffer the header.
 * We use `readBoxSizeUnbounded` instead, then bounds-check
 * separately against `source.byteLength`.
 */
async function enumerateTopBoxes(
  source: Fmp4Source,
): Promise<Array<{ name: string; start: number; end: number }>> {
  const out: Array<{ name: string; start: number; end: number }> = [];
  let pos = 0;
  while (pos + 8 <= source.byteLength) {
    const headerLen = Math.min(16, source.byteLength - pos);
    const headerBytes = await source.read(pos, headerLen);
    if (headerBytes.byteLength < 8) break;
    const hdr = readBoxSizeUnbounded(headerBytes);
    if (!hdr) break;
    // size==0 means "extends to EOF" — only legal on the final box.
    const total = hdr.totalSize === -1 ? source.byteLength - pos : hdr.totalSize;
    if (total < 8 || total > source.byteLength - pos) break;
    out.push({ name: hdr.name, start: pos, end: pos + total });
    pos += total;
  }
  return out;
}

/**
 * Parse a box header from a 16-byte (or smaller, ≥8 byte) slice WITHOUT
 * bounds-checking the body against the caller's buffer. Returns
 * `totalSize: -1` for size==0 (caller resolves with source EOF).
 *
 * The non-streaming `readBoxHeader` below additionally bounds-checks
 * `size <= buf.byteLength - offset`. That check enforces "box must
 * fit in the buffer" — correct when the buffer is the full file but
 * wrong when the buffer only holds the header.
 */
function readBoxSizeUnbounded(headerBytes: Uint8Array): { name: string; totalSize: number } | null {
  if (headerBytes.byteLength < 8) return null;
  let size = readU32(headerBytes, 0);
  const name = readName(headerBytes, 4);
  if (size === 1) {
    if (headerBytes.byteLength < 16) return null;
    const hi = readU32(headerBytes, 8);
    const lo = readU32(headerBytes, 12);
    // Bound the largesize at MAX_SAFE_INTEGER (see readBoxHeader notes).
    if (hi > 0x1fffff) return null;
    size = hi * 0x100000000 + lo;
    if (size < 16) return null;
  } else if (size === 0) {
    return { name, totalSize: -1 };
  } else if (size < 8) {
    return null;
  }
  return { name, totalSize: size };
}

async function parseFmp4Structure(source: Fmp4Source): Promise<ParsedFmp4> {
  // Pass 1: enumerate every top-level box via the buffered walker.
  // Handles:
  //   - 64-bit largesize boxes (size == 1, real size in 8 bytes after
  //     the type field). YouTube uses these for the per-fragment mdat
  //     on higher-bitrate AVC tracks even when the body would fit in
  //     32 bits — packager convention varies.
  //   - boxes interleaved between moof and mdat (styp, free, skip,
  //     sidx). The ISO spec doesn't actually require moof to be
  //     immediately followed by mdat.
  // Pass 2 then finds ftyp / moov and pairs each moof with the
  // closest following mdat.
  const boxes = await enumerateTopBoxes(source);

  let ftypRange: Range | null = null;
  let moovRange: Range | null = null;
  for (const b of boxes) {
    if (b.name === 'ftyp' && !ftypRange) ftypRange = { start: b.start, end: b.end };
    else if (b.name === 'moov' && !moovRange) moovRange = { start: b.start, end: b.end };
  }

  const fragments: Array<{ moofRange: Range; mdatRange: Range }> = [];
  for (let m = 0; m < boxes.length; m += 1) {
    if (boxes[m].name !== 'moof') continue;
    let pairedMdat: { name: string; start: number; end: number } | null = null;
    for (let n = m + 1; n < boxes.length; n += 1) {
      const candidate = boxes[n];
      if (candidate.name === 'mdat') {
        pairedMdat = candidate;
        break;
      }
      if (candidate.name === 'moof') break; // another moof before an mdat — malformed
      // Otherwise skip styp / free / skip / sidx / etc.
    }
    if (!pairedMdat) {
      throw new RemuxError(
        `mp4-combine: moof at offset ${boxes[m].start} has no matching mdat ` +
          `(top-level box sequence: ${boxes.map((b) => b.name).join(',')})`,
      );
    }
    fragments.push({
      moofRange: { start: boxes[m].start, end: boxes[m].end },
      mdatRange: { start: pairedMdat.start, end: pairedMdat.end },
    });
  }

  if (!ftypRange) throw new RemuxError('mp4-combine: input is missing ftyp');
  if (!moovRange) throw new RemuxError('mp4-combine: input is missing moov');
  if (fragments.length === 0) {
    throw new RemuxError(
      `mp4-combine: input has no moof/mdat fragments ` +
        `(top-level box sequence: ${boxes.map((b) => b.name).join(',')})`,
    );
  }

  // Read ftyp + moov into memory in full. Both are small (ftyp is a
  // handful of bytes; moov is tens to a few hundred KB even for long
  // videos — per-sample tables live in moof.trun, not stsz/stco).
  const ftypBytes = await source.read(ftypRange.start, ftypRange.end - ftypRange.start);
  const moovBytes = await source.read(moovRange.start, moovRange.end - moovRange.start);
  // Detach views — moovBytes may be a subarray of the parser's
  // buffered chunk; we want a stable, owned copy because we hand it
  // back to caller-side helpers that operate on it for the duration
  // of the combine pass.
  const moov = moovBytes instanceof Uint8Array ? new Uint8Array(moovBytes) : moovBytes;
  const ftyp = ftypBytes instanceof Uint8Array ? new Uint8Array(ftypBytes) : ftypBytes;

  // Locate the single trak + mvhd within `moov` (offsets relative to
  // the moov buffer, NOT the source).
  let trakRange: Range | null = null;
  let mvhdRange: Range | null = null;
  walkBoxes(moov, 8, moov.byteLength, (name, start, end) => {
    if (name === 'trak') {
      if (trakRange) throw new RemuxError('mp4-combine: input has more than one trak (unexpected)');
      trakRange = { start, end };
    } else if (name === 'mvhd') {
      mvhdRange = { start, end };
    }
  });
  if (!trakRange) throw new RemuxError('mp4-combine: input moov has no trak');
  if (!mvhdRange) throw new RemuxError('mp4-combine: input moov has no mvhd');

  // mvhd layout: version(1)+flags(3) + creation + modification + timescale + duration + ...
  // v0: timescale at +12 (4 bytes), duration at +16 (4 bytes).
  // v1: timescale at +20 (4 bytes), duration at +24 (8 bytes).
  const mvhdBody = (mvhdRange as Range).start + 8;
  const mvhdVersion = moov[mvhdBody];
  const movieTimescale =
    mvhdVersion === 0 ? readU32(moov, mvhdBody + 12) : readU32(moov, mvhdBody + 20);
  const mvhdDurTicks =
    mvhdVersion === 0 ? readU32(moov, mvhdBody + 16) : Number(readU64BigInt(moov, mvhdBody + 24));

  // Track timescale from mdia → mdhd inside trak.
  let trackTimescale = 0;
  walkBoxes(moov, (trakRange as Range).start + 8, (trakRange as Range).end, (name, start, end) => {
    if (name !== 'mdia') return;
    walkBoxes(moov, start + 8, end, (subName, subStart) => {
      if (subName !== 'mdhd') return;
      const body = subStart + 8;
      const v = moov[body];
      trackTimescale = v === 0 ? readU32(moov, body + 12) : readU32(moov, body + 20);
    });
  });
  if (trackTimescale === 0) {
    throw new RemuxError('mp4-combine: track has no mdhd timescale');
  }

  // mvhd.duration is unreliable in fragmented MP4: the spec lets
  // packagers leave it at 0 or 0xFFFFFFFF (the "unknown — derive from
  // fragments" sentinel) since the real timeline lives in moof.tfdt +
  // trun.sample_duration. googlevideo populates it, but generic DASH
  // packagers often don't — and VLC reads the sentinel literally as
  // ~57 days. When the mvhd value isn't usable, walk the last fragment
  // and compute the track duration from the actual sample timing.
  const mvhdUsable = mvhdDurTicks > 0 && mvhdDurTicks !== 0xffffffff && mvhdDurTicks < 0x100000000;
  const durationSeconds = mvhdUsable
    ? mvhdDurTicks / movieTimescale
    : await deriveTrackDurationFromLastFragmentSeconds(source, moov, fragments, trackTimescale);

  return {
    ftypBytes: ftyp,
    moovBytes: moov,
    trakRange,
    mvhdRange,
    durationSeconds,
    movieTimescale,
    trackTimescale,
    fragments,
  };
}

/**
 * Compute the track duration in seconds by walking the last moof's
 * traf: `tfdt + sum(trun.sample_duration)`. Falls back to trex /
 * tfhd default_sample_duration for trun runs without per-sample
 * durations. Returns 0 when no usable timing info exists — the caller
 * combines via Math.max so a single zero falls through to the other
 * input's duration cleanly.
 */
async function deriveTrackDurationFromLastFragmentSeconds(
  source: Fmp4Source,
  moov: Uint8Array,
  fragments: Array<{ moofRange: Range; mdatRange: Range }>,
  trackTimescale: number,
): Promise<number> {
  if (fragments.length === 0 || trackTimescale === 0) return 0;
  // trex default_sample_duration (per-track defaults declared in mvex).
  let trexDefaultSampleDuration = 0;
  walkBoxes(moov, 8, moov.byteLength, (name, start, end) => {
    if (name !== 'mvex') return;
    walkBoxes(moov, start + 8, end, (subName, subStart) => {
      if (subName !== 'trex') return;
      // trex body: version+flags(4) + track_ID(4) +
      //   default_sample_description_index(4) +
      //   default_sample_duration(4) + ...
      trexDefaultSampleDuration = readU32(moov, subStart + 8 + 12);
    });
  });

  const last = fragments[fragments.length - 1];
  const moofLen = last.moofRange.end - last.moofRange.start;
  const moofBytes = await source.read(last.moofRange.start, moofLen);
  let tfdtTicks = 0;
  let runDuration = 0;
  let tfhdDefaultSampleDuration = trexDefaultSampleDuration;
  walkBoxes(moofBytes, 8, moofBytes.byteLength, (name, start, end) => {
    if (name !== 'traf') return;
    walkBoxes(moofBytes, start + 8, end, (subName, subStart, subEnd) => {
      if (subName === 'tfhd') {
        const body = subStart + 8;
        const flags =
          (moofBytes[body + 1] << 16) | (moofBytes[body + 2] << 8) | moofBytes[body + 3];
        let p = body + 8; // skip version+flags(4) + track_ID(4)
        if (flags & 0x000001) p += 8; // base_data_offset_present
        if (flags & 0x000002) p += 4; // sample_description_index_present
        if (flags & 0x000008) {
          tfhdDefaultSampleDuration = readU32(moofBytes, p);
          // p += 4 — no more reads needed past this.
        }
      } else if (subName === 'tfdt') {
        const body = subStart + 8;
        const v = moofBytes[body];
        tfdtTicks =
          v === 0 ? readU32(moofBytes, body + 4) : Number(readU64BigInt(moofBytes, body + 4));
      } else if (subName === 'trun') {
        const body = subStart + 8;
        const flags =
          (moofBytes[body + 1] << 16) | (moofBytes[body + 2] << 8) | moofBytes[body + 3];
        const sampleCount = readU32(moofBytes, body + 4);
        let off = body + 8;
        if (flags & 0x000001) off += 4; // data_offset
        if (flags & 0x000004) off += 4; // first_sample_flags
        const hasDur = !!(flags & 0x000100);
        const hasSize = !!(flags & 0x000200);
        const hasFlg = !!(flags & 0x000400);
        const hasCto = !!(flags & 0x000800);
        const perSample =
          (hasDur ? 4 : 0) + (hasSize ? 4 : 0) + (hasFlg ? 4 : 0) + (hasCto ? 4 : 0);
        if (hasDur) {
          for (let s = 0; s < sampleCount; s += 1) {
            if (off + 4 > subEnd) break;
            runDuration += readU32(moofBytes, off);
            off += perSample;
          }
        } else {
          runDuration += sampleCount * tfhdDefaultSampleDuration;
        }
      }
    });
  });
  return (tfdtTicks + runDuration) / trackTimescale;
}

// ---------- combined moov assembly ----------

function buildCombinedMoov(args: {
  videoParsed: ParsedFmp4;
  audioParsed: ParsedFmp4;
  audioNewTrackId: number;
}): Uint8Array {
  const { videoParsed, audioParsed, audioNewTrackId } = args;
  const videoMoov = videoParsed.moovBytes;
  const audioMoov = audioParsed.moovBytes;

  // New mvhd: copy the video's, patch duration to max(both, in video's
  // movie timescale), and bump next_track_ID past whatever the inputs
  // claimed. parseFmp4Structure has already fallen back to
  // fragment-derived duration when either source's mvhd was zero or
  // the 0xFFFFFFFF "unknown" sentinel, so durationSeconds here is
  // always a real number even for generic-DASH packagers that don't
  // populate the init segment.
  const mvhdSrc = videoMoov.subarray(videoParsed.mvhdRange.start, videoParsed.mvhdRange.end);
  const newMvhd = new Uint8Array(mvhdSrc);
  const mvhdBody = 8;
  const mvhdVersion = newMvhd[mvhdBody];
  const longestSecs = Math.max(videoParsed.durationSeconds, audioParsed.durationSeconds);
  const newDurTicks = Math.round(longestSecs * videoParsed.movieTimescale);
  if (mvhdVersion === 0) {
    writeU32(newMvhd, mvhdBody + 16, newDurTicks >>> 0);
  } else {
    writeU64(newMvhd, mvhdBody + 24, newDurTicks);
  }
  // next_track_ID is the last 4 bytes of mvhd in BOTH v0 and v1
  // layouts. Set it past the highest assigned ID (audioNewTrackId).
  const nextTrackIdOffset = newMvhd.byteLength - 4;
  writeU32(newMvhd, nextTrackIdOffset, audioNewTrackId + 1);

  // Video trak: verbatim from the source's moov.
  const videoTrak = videoMoov.subarray(videoParsed.trakRange.start, videoParsed.trakRange.end);

  // Audio trak: copy then renumber tkhd.track_id to audioNewTrackId.
  const audioTrak = new Uint8Array(
    audioMoov.subarray(audioParsed.trakRange.start, audioParsed.trakRange.end),
  );
  patchTkhdTrackId(audioTrak, audioNewTrackId);

  // Preserve any extra top-level boxes from the video's moov that we
  // didn't account for (mvex, udta, iods, etc.). Walk the video moov;
  // skip mvhd + every trak (we provide our own); copy the rest as-is.
  const passthrough: Uint8Array[] = [];
  walkBoxes(videoMoov, 8, videoMoov.byteLength, (name, start, end) => {
    if (name === 'mvhd' || name === 'trak') return;
    passthrough.push(videoMoov.subarray(start, end));
  });

  // Same pass over the audio moov, but only for boxes we genuinely
  // need to keep — `mvex` is the one that matters (track-extends
  // declarations). We skip mvex from the video pass-through above and
  // build a fresh combined one here so both tracks are represented.
  const combinedMvex = buildCombinedMvex(videoParsed, audioParsed, audioNewTrackId);

  // Assemble: moov = mvhd + videoTrak + audioTrak + combinedMvex + passthrough.
  return makeBox(
    'moov',
    newMvhd,
    videoTrak,
    audioTrak,
    ...(combinedMvex ? [combinedMvex] : []),
    ...passthrough.filter((box) => readName(box, 4) !== 'mvex'),
  );
}

/**
 * Combine the two inputs' mvex boxes into one. fMP4 requires mvex with
 * one `trex` per track declaring default sample flags / durations. We
 * concatenate the video's trex (track_ID untouched) with the audio's
 * trex (track_ID rewritten to the new value).
 *
 * Returns null when neither input has an mvex — extremely rare for
 * fMP4 but we'd rather emit a moov that elides mvex than crash on a
 * non-standard input.
 */
function buildCombinedMvex(
  videoParsed: ParsedFmp4,
  audioParsed: ParsedFmp4,
  audioNewTrackId: number,
): Uint8Array | null {
  const videoMvexChildren = collectMvexChildren(videoParsed);
  const audioMvexChildren = collectMvexChildren(audioParsed);

  if (videoMvexChildren.length === 0 && audioMvexChildren.length === 0) return null;

  const children: Uint8Array[] = [];
  // Pass through everything from the video's mvex (mehd + trex + ...).
  for (const child of videoMvexChildren) children.push(child);
  // From the audio's mvex, pull just the trex(es), patch their
  // track_ID, and append. Skip mehd — the video's already covers the
  // longer duration.
  for (const child of audioMvexChildren) {
    if (readName(child, 4) !== 'trex') continue;
    const patched = new Uint8Array(child);
    // trex layout: size(4) + type(4) + version+flags(4) + track_ID(4) + ...
    writeU32(patched, 12, audioNewTrackId);
    children.push(patched);
  }

  return makeBox('mvex', ...children);
}

function collectMvexChildren(parsed: ParsedFmp4): Uint8Array[] {
  const moov = parsed.moovBytes;
  const children: Uint8Array[] = [];
  walkBoxes(moov, 8, moov.byteLength, (name, start, end) => {
    if (name !== 'mvex') return;
    walkBoxes(moov, start + 8, end, (_subName, subStart, subEnd) => {
      children.push(new Uint8Array(moov.subarray(subStart, subEnd)));
    });
  });
  return children;
}

// ---------- per-fragment work ----------

interface FragmentRef {
  side: 'video' | 'audio';
  source: Fmp4Source;
  /** Absolute offsets in the source file. */
  moofRange: Range;
  mdatRange: Range;
  /** tfdt time converted to seconds via the track's timescale. */
  tfdtSeconds: number;
  /** Total bytes of moof + mdat. */
  totalBytes: number;
}

/**
 * Reads each fragment's moof to extract its tfdt for time-ordered
 * interleaving. We don't keep the moof bytes around — combineFmp4
 * re-reads them when it's the fragment's turn to write. The wasted
 * read is the cost of streaming the source (vs. holding the whole
 * file in memory for the whole pass).
 */
async function collectFragments(
  parsed: ParsedFmp4,
  source: Fmp4Source,
  side: 'video' | 'audio',
): Promise<FragmentRef[]> {
  const out: FragmentRef[] = [];
  for (const frag of parsed.fragments) {
    const moofLen = frag.moofRange.end - frag.moofRange.start;
    const moofBytes = await source.read(frag.moofRange.start, moofLen);
    const tfdtTicks = readTfdtTicks(moofBytes);
    out.push({
      side,
      source,
      moofRange: frag.moofRange,
      mdatRange: frag.mdatRange,
      tfdtSeconds: parsed.trackTimescale > 0 ? tfdtTicks / parsed.trackTimescale : 0,
      totalBytes:
        frag.moofRange.end - frag.moofRange.start + (frag.mdatRange.end - frag.mdatRange.start),
    });
  }
  return out;
}

function readTfdtTicks(moofBytes: Uint8Array): number {
  // moof → traf → tfdt. Single traf per moof (single-track fMP4).
  let ticks = 0;
  walkBoxes(moofBytes, 8, moofBytes.byteLength, (name, start, end) => {
    if (name !== 'traf') return;
    walkBoxes(moofBytes, start + 8, end, (subName, subStart) => {
      if (subName !== 'tfdt') return;
      const body = subStart + 8;
      const version = moofBytes[body];
      ticks =
        version === 0 ? readU32(moofBytes, body + 4) : Number(readU64BigInt(moofBytes, body + 4));
    });
  });
  return ticks;
}

function patchMfhdSequence(moof: Uint8Array, sequenceNumber: number): void {
  // First child of moof is mfhd. Body: version(1)+flags(3) + seq(4).
  walkBoxes(moof, 8, moof.byteLength, (name, start) => {
    if (name !== 'mfhd') return;
    writeU32(moof, start + 8 + 4, sequenceNumber >>> 0);
  });
}

function patchAllTfhdTrackIds(moof: Uint8Array, newTrackId: number): void {
  walkBoxes(moof, 8, moof.byteLength, (name, start, end) => {
    if (name !== 'traf') return;
    walkBoxes(moof, start + 8, end, (subName, subStart) => {
      if (subName !== 'tfhd') return;
      // tfhd body: version+flags(4) + track_ID(4) + ...
      writeU32(moof, subStart + 8 + 4, newTrackId >>> 0);
    });
  });
}

function readTrackIdFromTrak(src: Uint8Array, trak: Range): number {
  let trackId = 1;
  walkBoxes(src, trak.start + 8, trak.end, (name, start) => {
    if (name !== 'tkhd') return;
    const body = start + 8;
    const version = src[body];
    // tkhd: version+flags(4) + creation + modification + track_ID + ...
    // v0: creation+modification are 4 bytes each → track_ID at +12.
    // v1: creation+modification are 8 bytes each → track_ID at +20.
    trackId = version === 0 ? readU32(src, body + 12) : readU32(src, body + 20);
  });
  return trackId;
}

function patchTkhdTrackId(trak: Uint8Array, newTrackId: number): void {
  walkBoxes(trak, 8, trak.byteLength, (name, start) => {
    if (name !== 'tkhd') return;
    const body = start + 8;
    const version = trak[body];
    if (version === 0) {
      writeU32(trak, body + 12, newTrackId);
    } else {
      writeU32(trak, body + 20, newTrackId);
    }
  });
}

// ---------- box primitives ----------

function makeBox(type: string, ...payloads: Uint8Array[]): Uint8Array {
  let total = 8;
  for (const p of payloads) total += p.byteLength;
  const out = new Uint8Array(total);
  writeU32(out, 0, total);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  let off = 8;
  for (const p of payloads) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

type BoxVisitor = (name: string, start: number, end: number) => void;

function walkBoxes(buf: Uint8Array, start: number, end: number, visit: BoxVisitor): void {
  let i = start;
  while (i + 8 <= end) {
    const hdr = readBoxHeader(buf, i);
    if (!hdr || i + hdr.totalSize > end) return;
    visit(hdr.name, i, i + hdr.totalSize);
    i += hdr.totalSize;
  }
}

interface BoxHeader {
  name: string;
  /** Total bytes consumed by the box including its header (and the
   *  optional 8-byte largesize prefix when size == 1). */
  totalSize: number;
}

/**
 * Read a box header at `offset`. Handles all three size encodings the
 * ISOBMFF spec defines:
 *   - size > 1: the box's full byte length (header + body).
 *   - size == 1: a 64-bit largesize value follows the type field
 *     (8 more bytes), and that's the real total size.
 *   - size == 0: "extends to end of file" — only valid for the last
 *     box. We treat it as buf.byteLength - offset.
 * Returns null when the header would extend past the end of the
 * buffer or the resulting box would exceed buf bounds.
 */
function readBoxHeader(buf: Uint8Array, offset: number): BoxHeader | null {
  if (offset + 8 > buf.byteLength) return null;
  let size = readU32(buf, offset);
  const name = readName(buf, offset + 4);
  if (size === 1) {
    if (offset + 16 > buf.byteLength) return null;
    const hi = readU32(buf, offset + 8);
    const lo = readU32(buf, offset + 12);
    // Bound the largesize at MAX_SAFE_INTEGER. A multi-petabyte box
    // wouldn't fit in JS heap anyway; rejecting it keeps the
    // subsequent slice/sub-walk math safe under JS Number semantics.
    if (hi > 0x1fffff) return null;
    size = hi * 0x100000000 + lo;
    if (size < 16) return null;
  } else if (size === 0) {
    size = buf.byteLength - offset;
  } else if (size < 8) {
    return null;
  }
  if (size > buf.byteLength - offset) return null;
  return { name, totalSize: size };
}

function readU32(buf: Uint8Array, off: number): number {
  return ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
}

function readU64BigInt(buf: Uint8Array, off: number): bigint {
  const hi = BigInt(readU32(buf, off));
  const lo = BigInt(readU32(buf, off + 4));
  return (hi << 32n) | lo;
}

function readName(buf: Uint8Array, off: number): string {
  return String.fromCharCode(buf[off], buf[off + 1], buf[off + 2], buf[off + 3]);
}

function writeU32(buf: Uint8Array, off: number, val: number): void {
  buf[off] = (val >>> 24) & 0xff;
  buf[off + 1] = (val >>> 16) & 0xff;
  buf[off + 2] = (val >>> 8) & 0xff;
  buf[off + 3] = val & 0xff;
}

function writeU64(buf: Uint8Array, off: number, val: number): void {
  const big = BigInt(val);
  writeU32(buf, off, Number((big >> 32n) & 0xffffffffn));
  writeU32(buf, off + 4, Number(big & 0xffffffffn));
}
