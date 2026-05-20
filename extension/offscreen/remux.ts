import muxjs, { type Transmuxer } from 'mux.js';
import { RemuxError } from '../lib/errors.js';

export interface RemuxSegment {
  bytes: Uint8Array;
  duration: number;
}

export interface RemuxProgress {
  done: number;
  totalSegs: number;
}

// Lazy segment source — lets the caller stage segments on OPFS and only
// hold one in memory at a time. Production downloads (v0.10+) use this
// path; tests and small downloads can still pass an in-memory array
// and the helper at remuxTsToMp4's entry will adapt it.
export interface RemuxSegmentSource {
  count: number;
  getSegment(index: number): Promise<RemuxSegment>;
}

// mux.js writes the OUTPUT MP4 at 90 kHz (the HLS standard movie timescale).
const HLS_TIMESCALE = 90_000;

/**
 * Remux MPEG-TS segments into a single fragmented MP4 buffer.
 *
 * Accepts either an in-memory array (back-compat for tests / small
 * downloads) or a `RemuxSegmentSource` that yields segments lazily.
 * The source path is what v0.10's OPFS workspace uses — only one
 * segment lives in JS heap at a time.
 *
 * mux.js is designed for HLS streaming: each segment is pushed
 * individually with `setBaseMediaDecodeTime(cumulative)` so the
 * resulting moof boxes stitch into one continuous timeline starting at
 * 0. Concatenating all segments and pushing once produces ONE giant
 * moof with the wrong tfdt.
 *
 * mux.js leaves the mvhd/tkhd/mdhd duration fields at the 0xFFFFFFFF
 * sentinel that fragmented MP4 uses for "compute from samples". Some
 * players (VLC) take the sentinel literally → ~13 hours of fake
 * duration and unusable seeking. We patch the moov afterward with the
 * real total duration so progress + seek work everywhere.
 *
 * Output is fragmented MP4 (fMP4) — H.264 + AAC stream copy.
 */
export function remuxTsToMp4(
  segmentsOrSource: RemuxSegment[] | RemuxSegmentSource,
  onProgress?: (p: RemuxProgress) => void,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const source: RemuxSegmentSource = Array.isArray(segmentsOrSource)
    ? {
        count: segmentsOrSource.length,
        getSegment: (i) => Promise.resolve(segmentsOrSource[i]),
      }
    : segmentsOrSource;
  if (source.count === 0) {
    return Promise.reject(new RemuxError('remuxTsToMp4: expected at least one segment'));
  }
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
  }
  return new Promise<Uint8Array>((resolve, reject) => {
    let transmuxer: Transmuxer;
    try {
      transmuxer = new muxjs.mp4.Transmuxer({ remux: true });
    } catch (err) {
      reject(new RemuxError(`failed to create transmuxer: ${errMsg(err)}`));
      return;
    }

    let initSegment: Uint8Array | null = null;
    const chunks: Uint8Array[] = [];
    let currentFragment: Uint8Array[] | null = null;
    let pendingDone: (() => void) | null = null;
    let aborted = false;
    let nextFragmentSequence = 1;

    transmuxer.on('data', (segment) => {
      try {
        if (!initSegment && segment.initSegment) {
          initSegment = segment.initSegment;
        }
        if (segment.data) {
          const normalized = normalizeMuxjsFragment(segment.data, nextFragmentSequence);
          nextFragmentSequence = normalized.nextSequence;
          if (!currentFragment) currentFragment = [];
          for (const c of normalized.chunks) currentFragment.push(c);
        }
      } catch (err) {
        aborted = true;
        reject(new RemuxError(`fragment normalization failed: ${errMsg(err)}`));
      }
    });

    transmuxer.on('done', () => {
      if (currentFragment) {
        for (const c of currentFragment) chunks.push(c);
        currentFragment = null;
      }
      const resolver = pendingDone;
      pendingDone = null;
      resolver?.();
    });

    function flushSegment(): Promise<void> {
      return new Promise<void>((res) => {
        pendingDone = res;
        try {
          transmuxer.flush();
        } catch (err) {
          aborted = true;
          reject(new RemuxError(`transmuxer flush failed: ${errMsg(err)}`));
          res();
        }
      });
    }

    (async () => {
      let cumulative90k = 0;
      try {
        for (let i = 0; i < source.count; i += 1) {
          if (aborted) return;
          if (signal?.aborted) {
            aborted = true;
            reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
            return;
          }
          const seg = await source.getSegment(i);
          if (aborted) return;
          transmuxer.setBaseMediaDecodeTime(cumulative90k);
          transmuxer.push(seg.bytes);
          await flushSegment();
          const segSecs = seg.duration > 0 ? seg.duration : 6;
          cumulative90k += Math.round(segSecs * HLS_TIMESCALE);
          onProgress?.({ done: i + 1, totalSegs: source.count });
        }
      } catch (err) {
        if (aborted) return;
        aborted = true;
        reject(new RemuxError(`transmuxer push failed: ${errMsg(err)}`));
        return;
      }

      if (!initSegment) {
        reject(new RemuxError('transmuxer produced no init segment — invalid MPEG-TS input?'));
        return;
      }
      if (chunks.length === 0) {
        reject(new RemuxError('transmuxer produced no media data'));
        return;
      }
      // Local non-null re-binding — control-flow narrowing on `initSegment`
      // is lost across the closure boundary in the for-loops below.
      const initBytes: Uint8Array = initSegment;

      // Concatenate init + all media chunks into a single MP4 buffer.
      let total = initBytes.byteLength;
      for (const c of chunks) total += c.byteLength;
      const out = new Uint8Array(total);
      out.set(initBytes, 0);
      let offset = initBytes.byteLength;
      for (const c of chunks) {
        out.set(c, offset);
        offset += c.byteLength;
      }

      // Patch the MP4 in place:
      //  1. Walk every moof in file order, sum per-track sample durations
      //     to derive cumulative tfdt values, and rewrite each moof's tfdt.
      //     mux.js always writes tfdt=0 (it expects MSE to layer the
      //     timeline). Without this, VLC plays every fragment at t=0.
      //  2. Use the per-track cumulative totals to patch mvhd / tkhd /
      //     mdhd duration fields (mux.js leaves them at the 0xFFFFFFFF
      //     sentinel, which VLC reports as ~13 hours).
      //
      // Using sample-duration sums (not EXTINF) closes the gaps that
      // appear when mux.js's emitted content is slightly shorter than the
      // declared HLS segment duration — those gaps would surface as blank
      // playback at the start of the file.
      try {
        const trackTimescales = collectTrackTimescales(out);
        const trackTotals = patchMoofTfdtsFromContent(out, trackTimescales);
        patchHeaderDurations(out, trackTotals, trackTimescales);
        // mux.js emits B-frame composition offsets as negative values but
        // leaves the trun version at 0 (unsigned). VLC reads those bits as
        // ~4.29e9 — a 13-hour PTS offset — and shows blank until it gives
        // up and resyncs. Promote any trun carrying a negative-looking cto
        // to version 1 (signed) so the offsets read correctly.
        promoteSignedCtoTruns(out);
      } catch {
        // Patching is best-effort. The MP4 plays either way; if a patch
        // step fails we still hand back what mux.js produced.
      }

      resolve(out);
    })();
  });
}

// ---------- mux.js output normalization ----------
//
// mux.js's "combined" event is built for MSE appendBuffer(), not for a
// standalone MP4 file. For audio+video HLS it emits:
//
//   audio moof + audio mdat + video moof + video mdat
//
// where both moofs describe the same time range. VLC may consume the first
// audio-only moof as the beginning of the movie, show no video for that
// fragment duration, then resync when it reaches the video moof at t=0. We
// rebuild each mux.js data event into a single proper movie fragment:
//
//   moof(mfhd, audio traf, video traf) + mdat(audio payload, video payload)
//
// and rewrite each trun.data_offset to point at its payload inside the new
// combined mdat.

interface MoofMdatPair {
  moofStart: number;
  moofEnd: number;
  mdatStart: number;
  mdatEnd: number;
}

function normalizeMuxjsFragment(
  data: Uint8Array,
  sequenceNumber: number,
): { chunks: Uint8Array[]; nextSequence: number } {
  const pairs = readMoofMdatPairs(data);
  if (!pairs || pairs.length === 0) {
    return { chunks: [data], nextSequence: sequenceNumber };
  }

  const trafs: Uint8Array[] = [];
  const payloads: Uint8Array[] = [];
  for (const pair of pairs) {
    const pairTrafs = extractTrafs(data, pair.moofStart + 8, pair.moofEnd);
    if (pairTrafs.length !== 1) {
      // Already combined, or not a mux.js shape we know how to rewrite.
      return { chunks: [data], nextSequence: sequenceNumber };
    }
    trafs.push(pairTrafs[0]);
    payloads.push(data.subarray(pair.mdatStart + 8, pair.mdatEnd));
  }

  const mfhd = makeMfhd(sequenceNumber);
  const moofSize = 8 + mfhd.byteLength + trafs.reduce((sum, traf) => sum + traf.byteLength, 0);
  let payloadOffset = moofSize + 8; // data_offset is relative to the start of moof.
  for (let i = 0; i < trafs.length; i += 1) {
    patchTrafTrunDataOffset(trafs[i], payloadOffset);
    payloadOffset += payloads[i].byteLength;
  }

  const moof = makeBox('moof', mfhd, ...trafs);
  const mdat = makeBox('mdat', ...payloads);
  return { chunks: [concatUint8([moof, mdat])], nextSequence: sequenceNumber + 1 };
}

function readMoofMdatPairs(buf: Uint8Array): MoofMdatPair[] | null {
  const pairs: MoofMdatPair[] = [];
  let p = 0;
  while (p + 8 <= buf.length) {
    const moofSize = readU32(buf, p);
    if (moofSize < 8 || moofSize > buf.length - p || readName(buf, p + 4) !== 'moof') {
      return null;
    }
    const moofStart = p;
    const moofEnd = p + moofSize;
    p = moofEnd;

    if (p + 8 > buf.length) return null;
    const mdatSize = readU32(buf, p);
    if (mdatSize < 8 || mdatSize > buf.length - p || readName(buf, p + 4) !== 'mdat') {
      return null;
    }
    const mdatStart = p;
    const mdatEnd = p + mdatSize;
    pairs.push({ moofStart, moofEnd, mdatStart, mdatEnd });
    p = mdatEnd;
  }

  return p === buf.length ? pairs : null;
}

function extractTrafs(buf: Uint8Array, start: number, end: number): Uint8Array[] {
  const trafs: Uint8Array[] = [];
  walkBoxes(buf, start, end, (name, bodyStart, bodyEnd) => {
    if (name === 'traf') {
      trafs.push(new Uint8Array(buf.subarray(bodyStart - 8, bodyEnd)));
    }
  });
  return trafs;
}

function patchTrafTrunDataOffset(traf: Uint8Array, dataOffset: number): void {
  let hasTfhd = false;
  let patched = false;
  walkBoxes(traf, 8, traf.byteLength, (name, bodyStart) => {
    if (name === 'tfhd') {
      // Multiple trafs share one moof after normalization. Make trun
      // data_offset unambiguously relative to this moof for every track.
      const flags = (traf[bodyStart + 1] << 16) | (traf[bodyStart + 2] << 8) | traf[bodyStart + 3];
      writeU24(traf, bodyStart + 1, flags | 0x020000);
      hasTfhd = true;
      return;
    }
    if (name !== 'trun') return;
    const flags = (traf[bodyStart + 1] << 16) | (traf[bodyStart + 2] << 8) | traf[bodyStart + 3];
    if (!(flags & 0x000001)) {
      throw new RemuxError('cannot combine mux.js fragment: trun has no data_offset field');
    }
    writeU32(traf, bodyStart + 8, dataOffset);
    patched = true;
  });
  if (!patched) {
    throw new RemuxError('cannot combine mux.js fragment: traf has no trun');
  }
  if (!hasTfhd) {
    throw new RemuxError('cannot combine mux.js fragment: traf has no tfhd');
  }
}

function makeMfhd(sequenceNumber: number): Uint8Array {
  const payload = new Uint8Array(8);
  writeU32(payload, 4, sequenceNumber);
  return makeBox('mfhd', payload);
}

function makeBox(type: string, ...payloads: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(8 + payloads.reduce((sum, payload) => sum + payload.byteLength, 0));
  writeU32(out, 0, out.byteLength);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  let offset = 8;
  for (const payload of payloads) {
    out.set(payload, offset);
    offset += payload.byteLength;
  }
  return out;
}

function concatUint8(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

// ---------- moov & moof patchers ----------
//
// mux.js writes a fragmented MP4 that's only safe to play inside an MSE
// pipeline where the player externalizes the timeline. Two things must be
// rewritten before the file plays correctly on disk:
//
//   1. Every moof's `tfdt.baseMediaDecodeTime` is 0 — every fragment
//      claims to be at t=0. We fix this by walking the file in order,
//      reading each moof's actual content duration (sum of trun sample
//      durations), and writing cumulative tfdts per track. Using content
//      duration (not the playlist's EXTINF) is essential — mux.js's
//      emitted content is often slightly shorter than EXTINF and the gap
//      shows up as blank playback at the start.
//
//   2. mvhd / tkhd / mdhd duration fields are 0xFFFFFFFF (the fragmented-
//      MP4 "unknown" sentinel). VLC reads that literally as ~13 hours.
//      We replace them with the per-track totals computed in step 1.
//
// All boxes mux.js produces are version 0 (32-bit fields).

function collectTrackTimescales(buf: Uint8Array): Map<number, number> {
  const out = new Map<number, number>(); // trackId -> timescale
  // Walk moov → trak → (tkhd → trackId, mdia → mdhd → timescale).
  let i = 0;
  while (i + 8 <= buf.length) {
    const size = readU32(buf, i);
    if (size < 8 || size > buf.length - i) break;
    const name = readName(buf, i + 4);
    if (name === 'moov') {
      collectFromMoov(buf, i + 8, i + size, out);
      break;
    }
    i += size;
  }
  return out;
}

function collectFromMoov(
  buf: Uint8Array,
  start: number,
  end: number,
  out: Map<number, number>,
): void {
  let i = start;
  while (i + 8 <= end) {
    const size = readU32(buf, i);
    if (size < 8 || size > end - i) return;
    const name = readName(buf, i + 4);
    if (name === 'trak') {
      collectFromTrak(buf, i + 8, i + size, out);
    }
    i += size;
  }
}

function collectFromTrak(
  buf: Uint8Array,
  start: number,
  end: number,
  out: Map<number, number>,
): void {
  let trackId = -1;
  let timescale = 0;
  let i = start;
  while (i + 8 <= end) {
    const size = readU32(buf, i);
    if (size < 8 || size > end - i) return;
    const name = readName(buf, i + 4);
    if (name === 'tkhd') {
      const body = i + 8;
      const version = buf[body];
      trackId = version === 0 ? readU32(buf, body + 12) : readU32(buf, body + 20);
    } else if (name === 'mdia') {
      let j = i + 8;
      const mdiaEnd = i + size;
      while (j + 8 <= mdiaEnd) {
        const ssize = readU32(buf, j);
        if (ssize < 8 || ssize > mdiaEnd - j) break;
        const sname = readName(buf, j + 4);
        if (sname === 'mdhd') {
          const mbody = j + 8;
          const mver = buf[mbody];
          timescale = mver === 0 ? readU32(buf, mbody + 12) : readU32(buf, mbody + 20);
        }
        j += ssize;
      }
    }
    i += size;
  }
  if (trackId >= 0 && timescale > 0) out.set(trackId, timescale);
}

/**
 * Walk moofs in file order; for each moof, write its tfdt to the running
 * cumulative for that track, then advance the cumulative by the sum of
 * the moof's trun sample durations (the actual emitted content time).
 *
 * @returns {Map<number, number>} per-track total emitted duration in the
 *   track's own (mdhd) timescale.
 */
function patchMoofTfdtsFromContent(
  buf: Uint8Array,
  trackTimescales: Map<number, number>,
): Map<number, number> {
  const cumulative = new Map<number, number>(); // trackId -> running tfdt (track timescale)
  let p = 0;
  while (p + 8 <= buf.length) {
    const size = readU32(buf, p);
    if (size < 8 || size > buf.length - p) break;
    const name = readName(buf, p + 4);
    if (name === 'moof') {
      patchMoofTrafs(buf, p + 8, p + size, cumulative, trackTimescales);
    }
    p += size;
  }
  return cumulative;
}

function patchMoofTrafs(
  buf: Uint8Array,
  start: number,
  end: number,
  cumulative: Map<number, number>,
  trackTimescales: Map<number, number>,
): void {
  let i = start;
  while (i + 8 <= end) {
    const size = readU32(buf, i);
    if (size < 8 || size > end - i) return;
    const name = readName(buf, i + 4);
    if (name === 'traf') {
      patchOneTraf(buf, i + 8, i + size, cumulative, trackTimescales);
    }
    i += size;
  }
}

function patchOneTraf(
  buf: Uint8Array,
  start: number,
  end: number,
  cumulative: Map<number, number>,
  trackTimescales: Map<number, number>,
): void {
  let trackId = -1;
  let defaultSampleDuration = 0;
  let tfdtAt = -1;
  let tfdtVersion = 0;
  let trunStart = -1;
  let trunSize = 0;

  let i = start;
  while (i + 8 <= end) {
    const size = readU32(buf, i);
    if (size < 8 || size > end - i) return;
    const name = readName(buf, i + 4);
    if (name === 'tfhd') {
      const body = i + 8;
      const flags = (buf[body + 1] << 16) | (buf[body + 2] << 8) | buf[body + 3];
      let p = body + 4 + 4; // version+flags + track_id
      trackId = readU32(buf, body + 4);
      if (flags & 0x000001) p += 8; // base_data_offset_present
      if (flags & 0x000002) p += 4; // sample_description_index_present
      if (flags & 0x000008) {
        defaultSampleDuration = readU32(buf, p);
        p += 4;
      }
    } else if (name === 'tfdt') {
      const body = i + 8;
      tfdtVersion = buf[body];
      tfdtAt = body + 4;
    } else if (name === 'trun') {
      trunStart = i + 8;
      trunSize = size - 8;
    }
    i += size;
  }

  if (trackId < 0 || tfdtAt < 0) return;
  if (!trackTimescales.has(trackId)) return;

  const current = cumulative.get(trackId) ?? 0;
  if (tfdtVersion === 0) {
    writeU32(buf, tfdtAt, current >>> 0);
  } else {
    writeU64(buf, tfdtAt, current);
  }

  // Advance by the emitted content duration (sum of trun sample durations).
  if (trunStart >= 0) {
    const contentDur = sumTrunSampleDurations(buf, trunStart, trunSize, defaultSampleDuration);
    cumulative.set(trackId, current + contentDur);
  }
}

function sumTrunSampleDurations(
  buf: Uint8Array,
  start: number,
  size: number,
  defaultDuration: number,
): number {
  const flags = (buf[start + 1] << 16) | (buf[start + 2] << 8) | buf[start + 3];
  const sampleCount = readU32(buf, start + 4);
  let off = start + 8;
  if (flags & 0x000001) off += 4; // data_offset
  if (flags & 0x000004) off += 4; // first_sample_flags
  const hasDur = !!(flags & 0x000100);
  const hasSize = !!(flags & 0x000200);
  const hasFlg = !!(flags & 0x000400);
  const hasCto = !!(flags & 0x000800);
  const perSample = (hasDur ? 4 : 0) + (hasSize ? 4 : 0) + (hasFlg ? 4 : 0) + (hasCto ? 4 : 0);
  const end = start + size;

  if (!hasDur) {
    return defaultDuration * sampleCount;
  }
  let total = 0;
  for (let s = 0; s < sampleCount; s += 1) {
    if (off + 4 > end) break;
    total += readU32(buf, off);
    off += perSample;
  }
  return total;
}

/**
 * Patch mvhd / per-track tkhd / per-track mdhd duration fields using the
 * per-track totals from patchMoofTfdtsFromContent.
 *
 *  - mvhd.duration is in MOVIE timescale (we read it from mvhd directly).
 *  - tkhd.duration is in MOVIE timescale.
 *  - mdhd.duration is in the TRACK's (media) timescale.
 *
 * We pick the longest track in seconds as the movie duration.
 */
function patchHeaderDurations(
  buf: Uint8Array,
  trackTotals: Map<number, number>,
  trackTimescales: Map<number, number>,
): void {
  if (trackTotals.size === 0) return;
  // Find moov + mvhd to read movie timescale.
  let movieTimescale = HLS_TIMESCALE;
  let moovStart = -1;
  let moovEnd = -1;
  let p = 0;
  while (p + 8 <= buf.length) {
    const size = readU32(buf, p);
    if (size < 8 || size > buf.length - p) break;
    if (readName(buf, p + 4) === 'moov') {
      moovStart = p + 8;
      moovEnd = p + size;
      break;
    }
    p += size;
  }
  if (moovStart < 0) return;

  // Read mvhd timescale first.
  walkBoxes(buf, moovStart, moovEnd, (name, bodyStart) => {
    if (name === 'mvhd') {
      const version = buf[bodyStart];
      movieTimescale = version === 0 ? readU32(buf, bodyStart + 12) : readU32(buf, bodyStart + 20);
    }
  });

  // Compute longest track in seconds.
  let movieDurSecs = 0;
  for (const [trackId, ticks] of trackTotals) {
    const ts = trackTimescales.get(trackId);
    if (!ts) continue;
    const secs = ticks / ts;
    if (secs > movieDurSecs) movieDurSecs = secs;
  }
  const mvhdDur = Math.round(movieDurSecs * movieTimescale);

  // Patch mvhd duration + walk each trak to patch tkhd and mdhd.
  walkBoxes(buf, moovStart, moovEnd, (name, bodyStart, bodyEnd) => {
    if (name === 'mvhd') {
      writeMvhdOrMdhdDuration(buf, bodyStart, mvhdDur);
    } else if (name === 'trak') {
      patchTrakBox(buf, bodyStart, bodyEnd, trackTotals, trackTimescales, mvhdDur);
    }
  });
}

function patchTrakBox(
  buf: Uint8Array,
  start: number,
  end: number,
  trackTotals: Map<number, number>,
  trackTimescales: Map<number, number>,
  mvhdDur: number,
): void {
  let trackId = -1;
  walkBoxes(buf, start, end, (name, bodyStart, bodyEnd) => {
    if (name === 'tkhd') {
      const version = buf[bodyStart];
      trackId = version === 0 ? readU32(buf, bodyStart + 12) : readU32(buf, bodyStart + 20);
      writeTkhdDuration(buf, bodyStart, mvhdDur);
    } else if (name === 'mdia') {
      walkBoxes(buf, bodyStart, bodyEnd, (subName, subStart) => {
        if (subName === 'mdhd' && trackId >= 0) {
          const totalTicks = trackTotals.get(trackId) ?? 0;
          writeMvhdOrMdhdDuration(buf, subStart, totalTicks);
        }
      });
    }
  });
}

// mvhd / mdhd layout: version(1)+flags(3) + creation + modification +
// timescale(4) + duration(4 or 8). v0 → duration at +16; v1 → +24.
function writeMvhdOrMdhdDuration(buf: Uint8Array, bodyStart: number, value: number): void {
  const version = buf[bodyStart];
  if (version === 0) {
    writeU32(buf, bodyStart + 16, value);
  } else {
    writeU64(buf, bodyStart + 24, value);
  }
}

// tkhd layout: version(1)+flags(3) + creation + modification + track_id(4) +
// reserved(4) + duration(4 or 8). v0 → duration at +20; v1 → +28.
function writeTkhdDuration(buf: Uint8Array, bodyStart: number, value: number): void {
  const version = buf[bodyStart];
  if (version === 0) {
    writeU32(buf, bodyStart + 20, value);
  } else {
    writeU64(buf, bodyStart + 28, value);
  }
}

/**
 * Walk every moof → traf → trun in the file. For each trun that carries
 * composition-time offsets (sample-cto-offsets-present flag), check if any
 * sample's cto has the high bit set — that means mux.js intended a
 * negative value but wrote it under version 0 (unsigned). Promote the trun
 * to version 1 (signed) so 32-bit two's-complement is the correct read.
 *
 * Box layout: trun body = version(1) + flags(3) + sample_count(4) + ...
 * We change only the version byte; the on-disk cto bits are unchanged
 * (signed vs unsigned is purely a reader interpretation).
 */
function promoteSignedCtoTruns(buf: Uint8Array): void {
  let p = 0;
  while (p + 8 <= buf.length) {
    const size = readU32(buf, p);
    if (size < 8 || size > buf.length - p) break;
    if (readName(buf, p + 4) === 'moof') {
      walkBoxes(buf, p + 8, p + size, (name, bodyStart, bodyEnd) => {
        if (name !== 'traf') return;
        walkBoxes(buf, bodyStart, bodyEnd, (sub, subStart, subEnd) => {
          if (sub !== 'trun') return;
          maybePromoteTrun(buf, subStart, subEnd);
        });
      });
    }
    p += size;
  }
}

function maybePromoteTrun(buf: Uint8Array, bodyStart: number, bodyEnd: number): void {
  const version = buf[bodyStart];
  if (version !== 0) return;
  const flags = (buf[bodyStart + 1] << 16) | (buf[bodyStart + 2] << 8) | buf[bodyStart + 3];
  const hasCto = !!(flags & 0x000800);
  if (!hasCto) return;
  const sampleCount = readU32(buf, bodyStart + 4);
  let off = bodyStart + 8;
  if (flags & 0x000001) off += 4; // data_offset
  if (flags & 0x000004) off += 4; // first_sample_flags
  const hasDur = !!(flags & 0x000100);
  const hasSize = !!(flags & 0x000200);
  const hasFlg = !!(flags & 0x000400);
  // sample layout: [dur?][size?][flags?][cto]
  const ctoOffsetInSample = (hasDur ? 4 : 0) + (hasSize ? 4 : 0) + (hasFlg ? 4 : 0);
  const perSample = ctoOffsetInSample + 4;
  let negFound = false;
  for (let s = 0; s < sampleCount; s += 1) {
    const ctoOff = off + s * perSample + ctoOffsetInSample;
    if (ctoOff + 4 > bodyEnd) break;
    // Sign bit set ⇒ value was meant to be negative under version 1.
    if (buf[ctoOff] & 0x80) {
      negFound = true;
      break;
    }
  }
  if (negFound) {
    buf[bodyStart] = 1;
  }
}

type BoxVisitor = (name: string, bodyStart: number, bodyEnd: number) => void;

function walkBoxes(buf: Uint8Array, start: number, end: number, visit: BoxVisitor): void {
  let i = start;
  while (i + 8 <= end) {
    const size = readU32(buf, i);
    if (size < 8 || size > end - i) return;
    const name = readName(buf, i + 4);
    visit(name, i + 8, i + size);
    i += size;
  }
}

function readU32(buf: Uint8Array, off: number): number {
  return ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
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

function writeU24(buf: Uint8Array, off: number, val: number): void {
  buf[off] = (val >>> 16) & 0xff;
  buf[off + 1] = (val >>> 8) & 0xff;
  buf[off + 2] = val & 0xff;
}

function writeU64(buf: Uint8Array, off: number, val: number): void {
  // val ≤ 2^53 — safe as Number for our purposes (max 285 years at 90 kHz).
  const big = BigInt(val);
  writeU32(buf, off, Number((big >> 32n) & 0xffffffffn));
  writeU32(buf, off + 4, Number(big & 0xffffffffn));
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
