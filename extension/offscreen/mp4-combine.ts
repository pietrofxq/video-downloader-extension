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

export interface CombineProgress {
  /** Bytes written to the OPFS output so far. */
  written: number;
  /** Total bytes that will be written (sum of inputs minus dropped sidx). */
  total: number;
}

/**
 * Combine the two fMP4 byte streams into a single MP4 written to
 * `outputHandle`. The output is fully written before this resolves; the
 * caller turns the file handle into a Blob URL afterward.
 *
 * Memory footprint is bounded by the larger of the two inputs (passed
 * in as Uint8Arrays) plus a small allocation for the rebuilt moov.
 *
 * @returns total bytes written to the output file.
 */
export async function combineFmp4(
  video: Uint8Array,
  audio: Uint8Array,
  outputHandle: FileSystemFileHandle,
  onProgress?: (p: CombineProgress) => void,
  signal?: AbortSignal,
): Promise<{ bytes: number }> {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('aborted', 'AbortError');
  }

  const videoParsed = parseFmp4Structure(video);
  const audioParsed = parseFmp4Structure(audio);

  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('aborted', 'AbortError');
  }

  // Track-ID assignment: video keeps whatever it has (typically 1),
  // audio gets renumbered to a value distinct from the video's. We
  // grab the actual video track_ID from its trak rather than assume 1,
  // because some YouTube responses use other IDs for the single track.
  const videoTrackId = readTrackIdFromTrak(video, videoParsed.trakRange);
  let audioTargetTrackId = videoTrackId === 1 ? 2 : 1;
  if (audioTargetTrackId === videoTrackId) audioTargetTrackId += 1;

  // Build the combined moov in memory. fMP4 moov is small (tens of KB
  // even for long videos — the per-sample tables live in the trun
  // boxes inside each moof, not in stsz/stco like a fully-packed MP4).
  const moov = buildCombinedMoov({
    videoSrc: video,
    videoParsed,
    audioSrc: audio,
    audioParsed,
    audioNewTrackId: audioTargetTrackId,
  });

  // Collect every (moof, mdat) pair from both inputs, tagged with its
  // tfdt time in seconds and the source side. Interleave by time.
  const fragments = collectFragments(video, videoParsed, 'video').concat(
    collectFragments(audio, audioParsed, 'audio'),
  );
  fragments.sort((a, b) => {
    if (a.tfdtSeconds !== b.tfdtSeconds) return a.tfdtSeconds - b.tfdtSeconds;
    // Ties: video first — gives the player the keyframe before audio.
    if (a.side !== b.side) return a.side === 'video' ? -1 : 1;
    return 0;
  });

  // Compute the total output size up-front so progress can be a real
  // fraction. ftyp + moov + sum(moof+mdat).
  const ftyp = video.subarray(videoParsed.ftypRange.start, videoParsed.ftypRange.end);
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
      // Snapshot moof bytes into a writeable buffer; mfhd / tfhd will
      // be patched per-fragment. mdat goes through unchanged.
      const moof = new Uint8Array(frag.source.subarray(frag.moofRange.start, frag.moofRange.end));
      patchMfhdSequence(moof, sequenceNumber);
      sequenceNumber += 1;
      if (frag.side === 'audio') {
        patchAllTfhdTrackIds(moof, audioTargetTrackId);
      }
      await writeChunk(moof);
      await writeChunk(frag.source.subarray(frag.mdatRange.start, frag.mdatRange.end));
    }
  } finally {
    await writable.close();
  }
  return { bytes: written };
}

// ---------- structure parsing ----------

interface Range {
  start: number;
  end: number;
}

interface ParsedFmp4 {
  ftypRange: Range;
  moovRange: Range;
  /** Range of the single <trak> inside moov, top-level box bounds. */
  trakRange: Range;
  /** mvhd box (top-level box bounds within moov). */
  mvhdRange: Range;
  /** Total playback duration in seconds (read from mvhd). */
  durationSeconds: number;
  /** Movie timescale (from mvhd). */
  movieTimescale: number;
  /** Track's own timescale (from mdhd inside mdia inside trak). */
  trackTimescale: number;
  /** (moof, mdat) pairs in file order. */
  fragments: Array<{ moofRange: Range; mdatRange: Range }>;
}

function parseFmp4Structure(buf: Uint8Array): ParsedFmp4 {
  // Pass 1: enumerate every top-level box. We do this in a single
  // walk so we can handle:
  //   - 64-bit largesize boxes (size == 1, real size in 8 bytes after
  //     the type field). YouTube uses these for the per-fragment mdat
  //     on higher-bitrate AVC tracks even when the body would fit in
  //     32 bits — packager convention varies.
  //   - boxes interleaved between moof and mdat (styp, free, skip,
  //     sidx). The ISO spec doesn't actually require moof to be
  //     immediately followed by mdat.
  // Pass 2 then finds ftyp / moov and pairs each moof with the
  // closest following mdat.
  interface TopBox {
    name: string;
    start: number;
    end: number;
  }
  const boxes: TopBox[] = [];
  let i = 0;
  while (i < buf.byteLength) {
    const hdr = readBoxHeader(buf, i);
    if (!hdr) break;
    boxes.push({ name: hdr.name, start: i, end: i + hdr.totalSize });
    i += hdr.totalSize;
  }

  let ftyp: Range | null = null;
  let moov: Range | null = null;
  for (const b of boxes) {
    if (b.name === 'ftyp' && !ftyp) ftyp = { start: b.start, end: b.end };
    else if (b.name === 'moov' && !moov) moov = { start: b.start, end: b.end };
  }

  const fragments: Array<{ moofRange: Range; mdatRange: Range }> = [];
  for (let m = 0; m < boxes.length; m += 1) {
    if (boxes[m].name !== 'moof') continue;
    let pairedMdat: TopBox | null = null;
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

  if (!ftyp) throw new RemuxError('mp4-combine: input is missing ftyp');
  if (!moov) throw new RemuxError('mp4-combine: input is missing moov');
  if (fragments.length === 0) {
    throw new RemuxError(
      `mp4-combine: input has no moof/mdat fragments ` +
        `(top-level box sequence: ${boxes.map((b) => b.name).join(',')})`,
    );
  }

  // Locate the single trak + mvhd inside moov.
  let trak: Range | null = null;
  let mvhd: Range | null = null;
  walkBoxes(buf, moov.start + 8, moov.end, (name, start, end) => {
    if (name === 'trak') {
      if (trak) throw new RemuxError('mp4-combine: input has more than one trak (unexpected)');
      trak = { start, end };
    } else if (name === 'mvhd') {
      mvhd = { start, end };
    }
  });
  if (!trak) throw new RemuxError('mp4-combine: input moov has no trak');
  if (!mvhd) throw new RemuxError('mp4-combine: input moov has no mvhd');

  // mvhd layout: version(1)+flags(3) + creation + modification + timescale + duration + ...
  // v0: timescale at +12 (4 bytes), duration at +16 (4 bytes).
  // v1: timescale at +20 (4 bytes), duration at +24 (8 bytes).
  const mvhdBody = (mvhd as Range).start + 8;
  const mvhdVersion = buf[mvhdBody];
  const movieTimescale =
    mvhdVersion === 0 ? readU32(buf, mvhdBody + 12) : readU32(buf, mvhdBody + 20);
  const mvhdDurTicks =
    mvhdVersion === 0 ? readU32(buf, mvhdBody + 16) : Number(readU64BigInt(buf, mvhdBody + 24));

  // Track timescale from mdia → mdhd inside trak.
  let trackTimescale = 0;
  walkBoxes(buf, (trak as Range).start + 8, (trak as Range).end, (name, start, end) => {
    if (name !== 'mdia') return;
    walkBoxes(buf, start + 8, end, (subName, subStart) => {
      if (subName !== 'mdhd') return;
      const body = subStart + 8;
      const v = buf[body];
      trackTimescale = v === 0 ? readU32(buf, body + 12) : readU32(buf, body + 20);
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
    : deriveTrackDurationFromLastFragmentSeconds(buf, moov, fragments, trackTimescale);

  return {
    ftypRange: ftyp,
    moovRange: moov,
    trakRange: trak,
    mvhdRange: mvhd,
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
function deriveTrackDurationFromLastFragmentSeconds(
  buf: Uint8Array,
  moovRange: Range,
  fragments: Array<{ moofRange: Range; mdatRange: Range }>,
  trackTimescale: number,
): number {
  if (fragments.length === 0 || trackTimescale === 0) return 0;
  // trex default_sample_duration (per-track defaults declared in mvex).
  let trexDefaultSampleDuration = 0;
  walkBoxes(buf, moovRange.start + 8, moovRange.end, (name, start, end) => {
    if (name !== 'mvex') return;
    walkBoxes(buf, start + 8, end, (subName, subStart) => {
      if (subName !== 'trex') return;
      // trex body: version+flags(4) + track_ID(4) +
      //   default_sample_description_index(4) +
      //   default_sample_duration(4) + ...
      trexDefaultSampleDuration = readU32(buf, subStart + 8 + 12);
    });
  });

  const last = fragments[fragments.length - 1];
  let tfdtTicks = 0;
  let runDuration = 0;
  let tfhdDefaultSampleDuration = trexDefaultSampleDuration;
  walkBoxes(buf, last.moofRange.start + 8, last.moofRange.end, (name, start, end) => {
    if (name !== 'traf') return;
    walkBoxes(buf, start + 8, end, (subName, subStart, subEnd) => {
      if (subName === 'tfhd') {
        const body = subStart + 8;
        const flags = (buf[body + 1] << 16) | (buf[body + 2] << 8) | buf[body + 3];
        let p = body + 8; // skip version+flags(4) + track_ID(4)
        if (flags & 0x000001) p += 8; // base_data_offset_present
        if (flags & 0x000002) p += 4; // sample_description_index_present
        if (flags & 0x000008) {
          tfhdDefaultSampleDuration = readU32(buf, p);
          // p += 4 — no more reads needed past this.
        }
      } else if (subName === 'tfdt') {
        const body = subStart + 8;
        const v = buf[body];
        tfdtTicks = v === 0 ? readU32(buf, body + 4) : Number(readU64BigInt(buf, body + 4));
      } else if (subName === 'trun') {
        const body = subStart + 8;
        const flags = (buf[body + 1] << 16) | (buf[body + 2] << 8) | buf[body + 3];
        const sampleCount = readU32(buf, body + 4);
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
            runDuration += readU32(buf, off);
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
  videoSrc: Uint8Array;
  videoParsed: ParsedFmp4;
  audioSrc: Uint8Array;
  audioParsed: ParsedFmp4;
  audioNewTrackId: number;
}): Uint8Array {
  const { videoSrc, videoParsed, audioSrc, audioParsed, audioNewTrackId } = args;

  // New mvhd: copy the video's, patch duration to max(both, in video's
  // movie timescale), and bump next_track_ID past whatever the inputs
  // claimed. parseFmp4Structure has already fallen back to
  // fragment-derived duration when either source's mvhd was zero or
  // the 0xFFFFFFFF "unknown" sentinel, so durationSeconds here is
  // always a real number even for generic-DASH packagers that don't
  // populate the init segment.
  const mvhdSrc = videoSrc.subarray(videoParsed.mvhdRange.start, videoParsed.mvhdRange.end);
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

  // Video trak: verbatim from the source.
  const videoTrak = videoSrc.subarray(videoParsed.trakRange.start, videoParsed.trakRange.end);

  // Audio trak: copy then renumber tkhd.track_id to audioNewTrackId.
  const audioTrak = new Uint8Array(
    audioSrc.subarray(audioParsed.trakRange.start, audioParsed.trakRange.end),
  );
  patchTkhdTrackId(audioTrak, audioNewTrackId);

  // Preserve any extra top-level boxes from the video's moov that we
  // didn't account for (mvex, udta, iods, etc.). Walk the video moov;
  // skip mvhd + every trak (we provide our own); copy the rest as-is.
  const passthrough: Uint8Array[] = [];
  walkBoxes(
    videoSrc,
    videoParsed.moovRange.start + 8,
    videoParsed.moovRange.end,
    (name, start, end) => {
      if (name === 'mvhd' || name === 'trak') return;
      passthrough.push(videoSrc.subarray(start, end));
    },
  );

  // Same pass over the audio moov, but only for boxes we genuinely
  // need to keep — `mvex` is the one that matters (track-extends
  // declarations). We skip mvex from the video pass-through above and
  // build a fresh combined one here so both tracks are represented.
  const combinedMvex = buildCombinedMvex(
    videoSrc,
    videoParsed,
    audioSrc,
    audioParsed,
    audioNewTrackId,
  );

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
  videoSrc: Uint8Array,
  videoParsed: ParsedFmp4,
  audioSrc: Uint8Array,
  audioParsed: ParsedFmp4,
  audioNewTrackId: number,
): Uint8Array | null {
  const videoMvexChildren = collectMvexChildren(videoSrc, videoParsed);
  const audioMvexChildren = collectMvexChildren(audioSrc, audioParsed);

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

function collectMvexChildren(src: Uint8Array, parsed: ParsedFmp4): Uint8Array[] {
  const children: Uint8Array[] = [];
  walkBoxes(src, parsed.moovRange.start + 8, parsed.moovRange.end, (name, start, end) => {
    if (name !== 'mvex') return;
    walkBoxes(src, start + 8, end, (_subName, subStart, subEnd) => {
      children.push(new Uint8Array(src.subarray(subStart, subEnd)));
    });
  });
  return children;
}

// ---------- per-fragment work ----------

interface FragmentRef {
  side: 'video' | 'audio';
  source: Uint8Array;
  moofRange: Range;
  mdatRange: Range;
  /** tfdt time converted to seconds via the track's timescale. */
  tfdtSeconds: number;
  /** Total bytes of moof + mdat. */
  totalBytes: number;
}

function collectFragments(
  src: Uint8Array,
  parsed: ParsedFmp4,
  side: 'video' | 'audio',
): FragmentRef[] {
  const out: FragmentRef[] = [];
  for (const frag of parsed.fragments) {
    const tfdtTicks = readTfdtTicks(src, frag.moofRange);
    out.push({
      side,
      source: src,
      moofRange: frag.moofRange,
      mdatRange: frag.mdatRange,
      tfdtSeconds: parsed.trackTimescale > 0 ? tfdtTicks / parsed.trackTimescale : 0,
      totalBytes:
        frag.moofRange.end - frag.moofRange.start + (frag.mdatRange.end - frag.mdatRange.start),
    });
  }
  return out;
}

function readTfdtTicks(src: Uint8Array, moof: Range): number {
  // moof → traf → tfdt. Single traf per moof (single-track fMP4).
  let ticks = 0;
  walkBoxes(src, moof.start + 8, moof.end, (name, start, end) => {
    if (name !== 'traf') return;
    walkBoxes(src, start + 8, end, (subName, subStart) => {
      if (subName !== 'tfdt') return;
      const body = subStart + 8;
      const version = src[body];
      ticks = version === 0 ? readU32(src, body + 4) : Number(readU64BigInt(src, body + 4));
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
