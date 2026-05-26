// fMP4 two-track combine muxer (v0.11.7).
//
// Takes two single-track fragmented-MP4 byte streams (video + audio) and
// produces ONE plain, non-fragmented MP4 with both tracks. The inputs come
// from YouTube's adaptive `videoplayback?...` URLs — each one is a
// single-track fMP4 in the shape:
//
//   ftyp
//   moov  (mvhd + one trak with EMPTY sample tables + mvex/trex)
//   sidx?
//   (moof + mdat)+
//
// Why non-fragmented output (and not interleaved fragments)?
//   v0.11.1–v0.11.6 emitted the two inputs' moofs interleaved by time,
//   each moof carrying a single track's traf. That is exactly the layout
//   AGENTS.md §8a(1) documents as breaking VLC: VLC consumes a single-track
//   moof as the start of the movie, desyncs its master (audio) clock, drops
//   video frames, and loses audio after a seek. The HLS path (remux.ts)
//   sidesteps this by packing both tracks' trafs into one moof per
//   fragment — but it can only do that because mux.js hands it
//   time-aligned audio+video per TS segment. YouTube's video and audio
//   fragments have INDEPENDENT boundaries (≈5–7s video, ≈10s audio), so
//   there is no clean per-fragment pairing. Instead we de-fragment: read
//   every fragment's trun into flat sample tables (stts/ctts/stsz/stsc/
//   co64/stss) and write one ordinary `moov + mdat` file — the structure
//   every player, VLC included, handles natively.
//
// What we build:
//   ftyp (fresh, isom/mp41)
//   moov
//     mvhd  (duration = max(video,audio); movie timescale = video's)
//     trak  video — track_ID 1, stsd from the input, populated tables
//     trak  audio — track_ID 2, stsd from the input, populated tables
//   mdat  (all samples; chunks interleaved by time for seek locality)
//
// Memory: per-sample metadata (sizes/durations/cto) lives in JS heap —
// bounded by sample count (a 4K hour-long video is ~10^5–10^6 samples ≈
// a few MB of arrays), not by file size. Sample *payload* never enters
// heap: it is stream-copied source → output in MDAT_COPY_CHUNK_BYTES
// slices, same as before. Chunk offsets use co64 (64-bit) unconditionally
// so multi-GB 4K output is addressable without a stco/co64 branch.

import { RemuxError } from '../lib/errors.js';

// ---------- public API ----------

/**
 * Read-only byte source the muxer pulls from. Implemented by
 * `memorySource(Uint8Array)` for in-process buffers and tests, and by
 * `fileSource(File)` for OPFS-staged inputs (the 4K path — fetching to
 * memory would peak at 1-3 GB per side).
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
  /** Total bytes that will be written. */
  total: number;
}

/**
 * Chunk size for streaming sample payload → output copies. Caps peak JS
 * heap during the write pass. Picked for 4K (a fragment's payload can be
 * a few MB; this copies it in slices).
 */
const MDAT_COPY_CHUNK_BYTES = 1 * 1024 * 1024;

const VIDEO_TRACK_ID = 1;
const AUDIO_TRACK_ID = 2;

/**
 * Combine the two single-track fMP4 byte streams into a single
 * non-fragmented MP4 written to `outputHandle`. The output is fully
 * written before this resolves; the caller turns the file handle into a
 * Blob URL afterward.
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
  throwIfAborted(signal);

  const videoParsed = await parseFmp4Structure(video);
  const audioParsed = await parseFmp4Structure(audio);
  throwIfAborted(signal);

  // De-fragment: walk every fragment's traf/trun into flat per-sample
  // tables plus a per-fragment "chunk" descriptor (where its payload
  // lives in the source, and how many bytes).
  const videoSamples = await collectSamples(videoParsed, video);
  const audioSamples = await collectSamples(audioParsed, audio);
  throwIfAborted(signal);

  if (videoSamples.chunks.length === 0 || audioSamples.chunks.length === 0) {
    throw new RemuxError('mp4-combine: one of the inputs yielded no samples');
  }

  // Output movie timescale = the video's. Track durations are derived
  // from the actual sample durations, so empty-moov inputs (mvhd/tkhd/
  // mdhd = 0, as ffmpeg's fragmenter emits) come out correct.
  const movieTimescale = videoParsed.movieTimescale > 0 ? videoParsed.movieTimescale : 1000;
  const videoSecs =
    videoParsed.trackTimescale > 0 ? videoSamples.totalDuration / videoParsed.trackTimescale : 0;
  const audioSecs =
    audioParsed.trackTimescale > 0 ? audioSamples.totalDuration / audioParsed.trackTimescale : 0;
  const longestSecs = Math.max(videoSecs, audioSecs);
  const movieDurationTicks = Math.round(longestSecs * movieTimescale);

  const ftyp = makeFtyp();

  const buildMoov = (videoChunkOffsets: number[], audioChunkOffsets: number[]): Uint8Array => {
    const mvhd = makeMvhd(movieTimescale, movieDurationTicks, AUDIO_TRACK_ID + 1);
    const videoTrak = buildFlatTrak({
      moov: videoParsed.moovBytes,
      trakRange: videoParsed.trakRange,
      trackId: VIDEO_TRACK_ID,
      trackTimescale: videoParsed.trackTimescale,
      outMovieTimescale: movieTimescale,
      inMovieTimescale: videoParsed.movieTimescale,
      samples: videoSamples,
      chunkOffsets: videoChunkOffsets,
    });
    const audioTrak = buildFlatTrak({
      moov: audioParsed.moovBytes,
      trakRange: audioParsed.trakRange,
      trackId: AUDIO_TRACK_ID,
      trackTimescale: audioParsed.trackTimescale,
      outMovieTimescale: movieTimescale,
      inMovieTimescale: audioParsed.movieTimescale,
      samples: audioSamples,
      chunkOffsets: audioChunkOffsets,
    });
    return makeBox('moov', mvhd, videoTrak, audioTrak);
  };

  // Pass 1: build the moov with placeholder chunk offsets to learn its
  // exact byte length. co64 entry COUNT (not the values) fixes the size,
  // so the pass-2 moov below is byte-identical in length.
  const videoOffsets = new Array<number>(videoSamples.chunks.length).fill(0);
  const audioOffsets = new Array<number>(audioSamples.chunks.length).fill(0);
  const moovSized = buildMoov(videoOffsets, audioOffsets);

  const MDAT_HEADER_BYTES = 16; // 64-bit largesize header
  const mdatDataStart = ftyp.byteLength + moovSized.byteLength + MDAT_HEADER_BYTES;

  // Interleave chunks (one per source fragment) by decode time so a player
  // scrubbing a local file finds both tracks near each other. Each chunk
  // is assigned its absolute byte offset in the output mdat; co64 for each
  // track then lists ITS chunks' offsets in track-sample order.
  interface OutChunk {
    side: 'v' | 'a';
    trackIndex: number;
    source: Fmp4Source;
    srcStart: number;
    byteLen: number;
    tfdt: number;
  }
  const ordered: OutChunk[] = [];
  videoSamples.chunks.forEach((c, i) =>
    ordered.push({
      side: 'v',
      trackIndex: i,
      source: video,
      srcStart: c.srcStart,
      byteLen: c.byteLen,
      tfdt: c.tfdtSeconds,
    }),
  );
  audioSamples.chunks.forEach((c, i) =>
    ordered.push({
      side: 'a',
      trackIndex: i,
      source: audio,
      srcStart: c.srcStart,
      byteLen: c.byteLen,
      tfdt: c.tfdtSeconds,
    }),
  );
  ordered.sort((a, b) => {
    if (a.tfdt !== b.tfdt) return a.tfdt - b.tfdt;
    // Ties: video first — keyframe ahead of the matching audio.
    if (a.side !== b.side) return a.side === 'v' ? -1 : 1;
    return 0;
  });

  let cursor = mdatDataStart;
  for (const c of ordered) {
    if (c.side === 'v') videoOffsets[c.trackIndex] = cursor;
    else audioOffsets[c.trackIndex] = cursor;
    cursor += c.byteLen;
  }
  const totalPayload = cursor - mdatDataStart;

  // Pass 2: real offsets. Length must match pass 1 — guard against a
  // logic slip that would desync every chunk offset from the file.
  const moov = buildMoov(videoOffsets, audioOffsets);
  if (moov.byteLength !== moovSized.byteLength) {
    throw new RemuxError(
      `mp4-combine: moov length changed between sizing passes ` +
        `(${moovSized.byteLength} → ${moov.byteLength})`,
    );
  }

  const mdatHeader = new Uint8Array(MDAT_HEADER_BYTES);
  writeU32(mdatHeader, 0, 1); // size==1 → 64-bit largesize follows the type
  mdatHeader[4] = 0x6d; // 'm'
  mdatHeader[5] = 0x64; // 'd'
  mdatHeader[6] = 0x61; // 'a'
  mdatHeader[7] = 0x74; // 't'
  writeU64(mdatHeader, 8, MDAT_HEADER_BYTES + totalPayload);

  const totalOut = ftyp.byteLength + moov.byteLength + MDAT_HEADER_BYTES + totalPayload;

  const writable = await outputHandle.createWritable({ keepExistingData: false });
  let written = 0;
  const writeChunk = async (chunk: Uint8Array): Promise<void> => {
    throwIfAborted(signal);
    await writable.write(chunk as Uint8Array<ArrayBuffer>);
    written += chunk.byteLength;
    onProgress?.({ written, total: totalOut });
  };

  try {
    await writeChunk(ftyp);
    await writeChunk(moov);
    await writeChunk(mdatHeader);
    // Stream each chunk's payload from its source in interleave order.
    for (const c of ordered) {
      throwIfAborted(signal);
      await copyRange(c.source, c.srcStart, c.byteLen, writeChunk, signal);
    }
  } finally {
    await writable.close();
  }
  return { bytes: written };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('aborted', 'AbortError');
  }
}

/**
 * Stream a byte range from a source to the write callback in chunks of up
 * to `MDAT_COPY_CHUNK_BYTES`. Peak JS heap is one chunk.
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
    throwIfAborted(signal);
    const take = Math.min(MDAT_COPY_CHUNK_BYTES, length - copied);
    const chunk = await source.read(offset + copied, take);
    if (chunk.byteLength === 0) {
      throw new RemuxError(
        `mp4-combine: source returned 0 bytes mid-copy at offset ${offset + copied}`,
      );
    }
    await writeChunk(chunk);
    copied += chunk.byteLength;
  }
}

// ---------- structure parsing ----------

interface Range {
  start: number;
  end: number;
}

interface ParsedFmp4 {
  /** Bytes of the source's moov (small — read in full during parse). */
  moovBytes: Uint8Array;
  /** Range of the single <trak> within `moovBytes`. */
  trakRange: Range;
  /** Movie timescale (from mvhd). */
  movieTimescale: number;
  /** Track's own media timescale (from mdhd inside mdia inside trak). */
  trackTimescale: number;
  /** (moof, mdat) pairs as absolute file offsets in the source. */
  fragments: Array<{ moofRange: Range; mdatRange: Range }>;
}

/**
 * Walk top-level boxes from the source, reading only each box's header
 * (8 bytes, +8 for a 64-bit largesize) rather than its body — the body
 * lives on disk in the streaming case. Tolerates styp/free/sidx between
 * moof and mdat, and 64-bit largesize mdats.
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
    const total = hdr.totalSize === -1 ? source.byteLength - pos : hdr.totalSize;
    if (total < 8 || total > source.byteLength - pos) break;
    out.push({ name: hdr.name, start: pos, end: pos + total });
    pos += total;
  }
  return out;
}

function readBoxSizeUnbounded(headerBytes: Uint8Array): { name: string; totalSize: number } | null {
  if (headerBytes.byteLength < 8) return null;
  let size = readU32(headerBytes, 0);
  const name = readName(headerBytes, 4);
  if (size === 1) {
    if (headerBytes.byteLength < 16) return null;
    const hi = readU32(headerBytes, 8);
    const lo = readU32(headerBytes, 12);
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
  const boxes = await enumerateTopBoxes(source);

  let moovRange: Range | null = null;
  let ftypSeen = false;
  for (const b of boxes) {
    if (b.name === 'ftyp') ftypSeen = true;
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
      if (candidate.name === 'moof') break;
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

  if (!ftypSeen) throw new RemuxError('mp4-combine: input is missing ftyp');
  if (!moovRange) throw new RemuxError('mp4-combine: input is missing moov');
  if (fragments.length === 0) {
    throw new RemuxError(
      `mp4-combine: input has no moof/mdat fragments ` +
        `(top-level box sequence: ${boxes.map((b) => b.name).join(',')})`,
    );
  }

  const moovRaw = await source.read(moovRange.start, moovRange.end - moovRange.start);
  const moov = moovRaw instanceof Uint8Array ? new Uint8Array(moovRaw) : moovRaw;

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

  const mvhdBody = (mvhdRange as Range).start + 8;
  const mvhdVersion = moov[mvhdBody];
  const movieTimescale =
    mvhdVersion === 0 ? readU32(moov, mvhdBody + 12) : readU32(moov, mvhdBody + 20);

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

  return { moovBytes: moov, trakRange, movieTimescale, trackTimescale, fragments };
}

// ---------- sample collection (de-fragmentation) ----------

interface TrackSamples {
  /** Per-sample decode durations (track timescale), in decode order. */
  durations: number[];
  /** Per-sample sizes in bytes, in decode order. */
  sizes: number[];
  /** Per-sample composition time offsets (track timescale). */
  ctos: number[];
  /** 1-based sample numbers that are sync samples (keyframes). */
  syncNums: number[];
  /** True when every sample is a sync sample (audio) — caller omits stss. */
  allSync: boolean;
  /** True when any cto is non-zero (caller emits ctts). */
  anyCto: boolean;
  /** True when any cto is negative (caller emits a version-1 ctts). */
  anyNegCto: boolean;
  /** Sample count per chunk (one chunk per source trun), in file order. */
  chunkSampleCounts: number[];
  /** Per-chunk source location + size + decode time. */
  chunks: Array<{ srcStart: number; byteLen: number; tfdtSeconds: number }>;
  totalDuration: number;
  totalBytes: number;
}

interface TrunRun {
  /** trun.data_offset relative to the fragment's base. */
  dataOffset: number;
  samples: Array<{ dur: number; size: number; cto: number; flags: number }>;
}

interface ParsedTraf {
  defaultBaseIsMoof: boolean;
  basePresent: boolean;
  baseDataOffset: number;
  baseDecode: number;
  runs: TrunRun[];
}

async function collectSamples(parsed: ParsedFmp4, source: Fmp4Source): Promise<TrackSamples> {
  const trex = readTrexDefaults(parsed.moovBytes);
  const s: TrackSamples = {
    durations: [],
    sizes: [],
    ctos: [],
    syncNums: [],
    allSync: true,
    anyCto: false,
    anyNegCto: false,
    chunkSampleCounts: [],
    chunks: [],
    totalDuration: 0,
    totalBytes: 0,
  };
  let sampleIndex = 0;
  for (const frag of parsed.fragments) {
    const moofRaw = await source.read(
      frag.moofRange.start,
      frag.moofRange.end - frag.moofRange.start,
    );
    const moof = moofRaw instanceof Uint8Array ? moofRaw : new Uint8Array(moofRaw);
    const traf = parseTraf(moof, trex);
    if (!traf || traf.runs.length === 0) {
      throw new RemuxError('mp4-combine: fragment has no parseable traf/trun');
    }
    const base = traf.defaultBaseIsMoof
      ? frag.moofRange.start
      : traf.basePresent
        ? traf.baseDataOffset
        : frag.moofRange.start;
    const tfdtSeconds = parsed.trackTimescale > 0 ? traf.baseDecode / parsed.trackTimescale : 0;

    for (const run of traf.runs) {
      const srcStart = base + run.dataOffset;
      let chunkBytes = 0;
      for (let i = 0; i < run.samples.length; i += 1) {
        const sm = run.samples[i];
        s.durations.push(sm.dur);
        s.sizes.push(sm.size);
        s.ctos.push(sm.cto);
        if (sm.cto !== 0) s.anyCto = true;
        if (sm.cto < 0) s.anyNegCto = true;
        s.totalDuration += sm.dur;
        s.totalBytes += sm.size;
        chunkBytes += sm.size;
        // sample_is_non_sync_sample is bit 0x00010000 of sample_flags.
        if (sm.flags & 0x00010000) s.allSync = false;
        else s.syncNums.push(sampleIndex + 1);
        sampleIndex += 1;
      }
      s.chunkSampleCounts.push(run.samples.length);
      s.chunks.push({ srcStart, byteLen: chunkBytes, tfdtSeconds });
    }
  }
  return s;
}

/** trex default_sample_{duration,size,flags} for the (single) track. */
function readTrexDefaults(moov: Uint8Array): { dur: number; size: number; flags: number } {
  let dur = 0;
  let size = 0;
  let flags = 0;
  walkBoxes(moov, 8, moov.byteLength, (name, start, end) => {
    if (name !== 'mvex') return;
    walkBoxes(moov, start + 8, end, (subName, subStart) => {
      if (subName !== 'trex') return;
      // trex body: version+flags(4) + track_ID(4) + default_sample_description_index(4)
      //   + default_sample_duration(4) + default_sample_size(4) + default_sample_flags(4)
      const body = subStart + 8;
      dur = readU32(moov, body + 12);
      size = readU32(moov, body + 16);
      flags = readU32(moov, body + 20);
    });
  });
  return { dur, size, flags };
}

function parseTraf(
  moof: Uint8Array,
  trex: { dur: number; size: number; flags: number },
): ParsedTraf | null {
  let result: ParsedTraf | null = null;
  walkBoxes(moof, 8, moof.byteLength, (name, start, end) => {
    if (name !== 'traf') return;
    let defaultBaseIsMoof = false;
    let basePresent = false;
    let baseDataOffset = 0;
    let defDur = trex.dur;
    let defSize = trex.size;
    let defFlags = trex.flags;
    let baseDecode = 0;
    const runs: TrunRun[] = [];

    walkBoxes(moof, start + 8, end, (n, s) => {
      if (n === 'tfhd') {
        const body = s + 8;
        const fl = (moof[body + 1] << 16) | (moof[body + 2] << 8) | moof[body + 3];
        defaultBaseIsMoof = !!(fl & 0x020000);
        let p = body + 8; // skip version+flags(4) + track_ID(4)
        if (fl & 0x000001) {
          basePresent = true;
          baseDataOffset = Number(readU64BigInt(moof, p));
          p += 8;
        }
        if (fl & 0x000002) p += 4; // sample_description_index
        if (fl & 0x000008) {
          defDur = readU32(moof, p);
          p += 4;
        }
        if (fl & 0x000010) {
          defSize = readU32(moof, p);
          p += 4;
        }
        if (fl & 0x000020) {
          defFlags = readU32(moof, p);
          p += 4;
        }
      } else if (n === 'tfdt') {
        const body = s + 8;
        const v = moof[body];
        baseDecode = v === 0 ? readU32(moof, body + 4) : Number(readU64BigInt(moof, body + 4));
      } else if (n === 'trun') {
        const body = s + 8;
        const version = moof[body];
        const fl = (moof[body + 1] << 16) | (moof[body + 2] << 8) | moof[body + 3];
        const sampleCount = readU32(moof, body + 4);
        let p = body + 8;
        let dataOffset = 0;
        if (fl & 0x000001) {
          dataOffset = readU32(moof, p) | 0; // signed
          p += 4;
        } else {
          throw new RemuxError('mp4-combine: trun without data_offset is unsupported');
        }
        let firstFlags: number | null = null;
        if (fl & 0x000004) {
          firstFlags = readU32(moof, p);
          p += 4;
        }
        const hasDur = !!(fl & 0x000100);
        const hasSize = !!(fl & 0x000200);
        const hasFlg = !!(fl & 0x000400);
        const hasCto = !!(fl & 0x000800);
        const samples: TrunRun['samples'] = [];
        for (let i = 0; i < sampleCount; i += 1) {
          let dur = defDur;
          let size = defSize;
          let flags = defFlags;
          let cto = 0;
          if (hasDur) {
            dur = readU32(moof, p);
            p += 4;
          }
          if (hasSize) {
            size = readU32(moof, p);
            p += 4;
          }
          if (hasFlg) {
            flags = readU32(moof, p);
            p += 4;
          }
          if (hasCto) {
            // v0 cto is unsigned; v1 is signed (B-frame offsets go negative).
            cto = version === 0 ? readU32(moof, p) : readU32(moof, p) | 0;
            p += 4;
          }
          if (i === 0 && firstFlags !== null) flags = firstFlags;
          samples.push({ dur, size, cto, flags });
        }
        runs.push({ dataOffset, samples });
      }
    });

    result = { defaultBaseIsMoof, basePresent, baseDataOffset, baseDecode, runs };
  });
  return result;
}

// ---------- flat trak / sample-table assembly ----------

function buildFlatTrak(args: {
  moov: Uint8Array;
  trakRange: Range;
  trackId: number;
  trackTimescale: number;
  outMovieTimescale: number;
  inMovieTimescale: number;
  samples: TrackSamples;
  chunkOffsets: number[];
}): Uint8Array {
  const {
    moov,
    trakRange,
    trackId,
    trackTimescale,
    outMovieTimescale,
    inMovieTimescale,
    samples,
    chunkOffsets,
  } = args;

  const trackDurTicks = samples.totalDuration; // track timescale
  const tkhdDurMovie =
    trackTimescale > 0 ? Math.round((trackDurTicks / trackTimescale) * outMovieTimescale) : 0;
  // Edit-list segment_duration is in the (input) movie timescale; convert
  // it to the output movie timescale. media_time is in the track timescale
  // and is left untouched. Ratio is 1 for the video track (we keep its
  // movie timescale) and (videoTs/audioTs) for the audio track.
  const editRatio = inMovieTimescale > 0 ? outMovieTimescale / inMovieTimescale : 1;

  const stbl = buildStbl(moov, trakRange, samples, chunkOffsets);

  const children: Uint8Array[] = [];
  walkBoxes(moov, trakRange.start + 8, trakRange.end, (name, start, end) => {
    if (name === 'tkhd') {
      const b = new Uint8Array(moov.subarray(start, end));
      const body = 8;
      const version = b[body];
      if (version === 0) {
        writeU32(b, body + 12, trackId);
        writeU32(b, body + 20, tkhdDurMovie);
      } else {
        writeU32(b, body + 20, trackId);
        writeU64(b, body + 28, tkhdDurMovie);
      }
      b[body + 3] |= 0x03; // track_enabled | track_in_movie
      children.push(b);
    } else if (name === 'edts') {
      const b = new Uint8Array(moov.subarray(start, end));
      if (editRatio !== 1) rescaleElstInPlace(b, editRatio);
      children.push(b);
    } else if (name === 'mdia') {
      children.push(buildMdia(moov, { start, end }, trackTimescale, trackDurTicks, stbl));
    } else {
      children.push(new Uint8Array(moov.subarray(start, end)));
    }
  });
  return makeBox('trak', ...children);
}

function buildMdia(
  moov: Uint8Array,
  mdiaRange: Range,
  trackTimescale: number,
  trackDurTicks: number,
  stbl: Uint8Array,
): Uint8Array {
  const children: Uint8Array[] = [];
  walkBoxes(moov, mdiaRange.start + 8, mdiaRange.end, (name, start, end) => {
    if (name === 'mdhd') {
      const b = new Uint8Array(moov.subarray(start, end));
      const body = 8;
      const version = b[body];
      if (version === 0) {
        writeU32(b, body + 12, trackTimescale);
        writeU32(b, body + 16, trackDurTicks);
      } else {
        writeU32(b, body + 20, trackTimescale);
        writeU64(b, body + 24, trackDurTicks);
      }
      children.push(b);
    } else if (name === 'minf') {
      children.push(buildMinf(moov, { start, end }, stbl));
    } else {
      children.push(new Uint8Array(moov.subarray(start, end)));
    }
  });
  return makeBox('mdia', ...children);
}

function buildMinf(moov: Uint8Array, minfRange: Range, stbl: Uint8Array): Uint8Array {
  const children: Uint8Array[] = [];
  walkBoxes(moov, minfRange.start + 8, minfRange.end, (name, start, end) => {
    if (name === 'stbl') children.push(stbl);
    else children.push(new Uint8Array(moov.subarray(start, end)));
  });
  return makeBox('minf', ...children);
}

function buildStbl(
  moov: Uint8Array,
  trakRange: Range,
  samples: TrackSamples,
  chunkOffsets: number[],
): Uint8Array {
  // stsd carries the codec config (avcC / esds); reuse the input's verbatim.
  const stsd = extractStsd(moov, trakRange);
  if (!stsd) throw new RemuxError('mp4-combine: input trak has no stsd');

  const boxes: Uint8Array[] = [stsd, makeStts(samples.durations)];
  if (samples.anyCto) boxes.push(makeCtts(samples.ctos, samples.anyNegCto));
  if (!samples.allSync && samples.syncNums.length > 0) boxes.push(makeStss(samples.syncNums));
  boxes.push(makeStsc(samples.chunkSampleCounts), makeStsz(samples.sizes), makeCo64(chunkOffsets));
  return makeBox('stbl', ...boxes);
}

function extractStsd(moov: Uint8Array, trakRange: Range): Uint8Array | null {
  let result: Uint8Array | null = null;
  walkBoxes(moov, trakRange.start + 8, trakRange.end, (n1, s1, e1) => {
    if (n1 !== 'mdia') return;
    walkBoxes(moov, s1 + 8, e1, (n2, s2, e2) => {
      if (n2 !== 'minf') return;
      walkBoxes(moov, s2 + 8, e2, (n3, s3, e3) => {
        if (n3 !== 'stbl') return;
        walkBoxes(moov, s3 + 8, e3, (n4, s4, e4) => {
          if (n4 === 'stsd') result = new Uint8Array(moov.subarray(s4, e4));
        });
      });
    });
  });
  return result;
}

function rescaleElstInPlace(edts: Uint8Array, ratio: number): void {
  walkBoxes(edts, 8, edts.byteLength, (name, start, end) => {
    if (name !== 'elst') return;
    const body = start + 8;
    const version = edts[body];
    const count = readU32(edts, body + 4);
    let p = body + 8;
    for (let i = 0; i < count; i += 1) {
      if (version === 0) {
        if (p + 12 > end) break;
        writeU32(edts, p, Math.round(readU32(edts, p) * ratio));
        p += 12;
      } else {
        if (p + 20 > end) break;
        writeU64(edts, p, Math.round(Number(readU64BigInt(edts, p)) * ratio));
        p += 20;
      }
    }
  });
}

// ---------- sample-table box builders ----------

/** stts: run-length (sample_count, sample_delta) over decode durations. */
function makeStts(durations: number[]): Uint8Array {
  const entries: Array<[number, number]> = [];
  for (const d of durations) {
    const last = entries[entries.length - 1];
    if (last && last[1] === d) last[0] += 1;
    else entries.push([1, d]);
  }
  const body = new Uint8Array(8 + entries.length * 8);
  writeU32(body, 4, entries.length);
  let p = 8;
  for (const [count, delta] of entries) {
    writeU32(body, p, count);
    writeU32(body, p + 4, delta);
    p += 8;
  }
  return makeBox('stts', body);
}

/** ctts: run-length (sample_count, sample_offset). v1 when offsets signed. */
function makeCtts(ctos: number[], signed: boolean): Uint8Array {
  const entries: Array<[number, number]> = [];
  for (const c of ctos) {
    const last = entries[entries.length - 1];
    if (last && last[1] === c) last[0] += 1;
    else entries.push([1, c]);
  }
  const body = new Uint8Array(8 + entries.length * 8);
  if (signed) body[0] = 1; // version 1 → signed sample_offset
  writeU32(body, 4, entries.length);
  let p = 8;
  for (const [count, offset] of entries) {
    writeU32(body, p, count);
    writeU32(body, p + 4, offset >>> 0); // two's-complement; v1 readers sign-extend
    p += 8;
  }
  return makeBox('ctts', body);
}

/** stsz: per-sample sizes (sample_size field 0). */
function makeStsz(sizes: number[]): Uint8Array {
  const body = new Uint8Array(12 + sizes.length * 4);
  // version+flags(4)=0, sample_size(4)=0, sample_count(4)
  writeU32(body, 8, sizes.length);
  let p = 12;
  for (const size of sizes) {
    writeU32(body, p, size);
    p += 4;
  }
  return makeBox('stsz', body);
}

/** stsc: one entry whenever consecutive chunks change samples-per-chunk. */
function makeStsc(chunkSampleCounts: number[]): Uint8Array {
  const entries: Array<[number, number]> = []; // [first_chunk, samples_per_chunk]
  for (let i = 0; i < chunkSampleCounts.length; i += 1) {
    const spc = chunkSampleCounts[i];
    const last = entries[entries.length - 1];
    if (last && last[1] === spc) continue;
    entries.push([i + 1, spc]);
  }
  const body = new Uint8Array(8 + entries.length * 12);
  writeU32(body, 4, entries.length);
  let p = 8;
  for (const [firstChunk, spc] of entries) {
    writeU32(body, p, firstChunk);
    writeU32(body, p + 4, spc);
    writeU32(body, p + 8, 1); // sample_description_index
    p += 12;
  }
  return makeBox('stsc', body);
}

/** co64: 64-bit chunk offsets (used unconditionally — handles 4K > 4 GB). */
function makeCo64(offsets: number[]): Uint8Array {
  const body = new Uint8Array(8 + offsets.length * 8);
  writeU32(body, 4, offsets.length);
  let p = 8;
  for (const off of offsets) {
    writeU64(body, p, off);
    p += 8;
  }
  return makeBox('co64', body);
}

/** stss: 1-based sync-sample numbers (omitted entirely when all sync). */
function makeStss(syncNums: number[]): Uint8Array {
  const body = new Uint8Array(8 + syncNums.length * 4);
  writeU32(body, 4, syncNums.length);
  let p = 8;
  for (const n of syncNums) {
    writeU32(body, p, n);
    p += 4;
  }
  return makeBox('stss', body);
}

// ---------- movie / file header builders ----------

function makeFtyp(): Uint8Array {
  // major_brand=isom, minor_version=512, compatible=[isom,iso2,avc1,mp41].
  const body = new Uint8Array(20);
  body.set(strBytes('isom'), 0);
  writeU32(body, 4, 512);
  body.set(strBytes('isom'), 8);
  body.set(strBytes('iso2'), 12);
  body.set(strBytes('mp41'), 16);
  return makeBox('ftyp', body);
}

/** mvhd v0 with identity matrix. */
function makeMvhd(timescale: number, durationTicks: number, nextTrackId: number): Uint8Array {
  const body = new Uint8Array(100);
  // version=0, flags=0; creation/modification=0.
  writeU32(body, 12, timescale);
  writeU32(body, 16, durationTicks >>> 0);
  writeU32(body, 20, 0x00010000); // rate 1.0
  body[24] = 0x01; // volume 1.0 (high byte)
  // unity matrix at +32 (a, e, w).
  writeU32(body, 32, 0x00010000);
  writeU32(body, 48, 0x00010000);
  writeU32(body, 68, 0x40000000);
  writeU32(body, 96, nextTrackId);
  return makeBox('mvhd', body);
}

function strBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i);
  return out;
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
  totalSize: number;
}

function readBoxHeader(buf: Uint8Array, offset: number): BoxHeader | null {
  if (offset + 8 > buf.byteLength) return null;
  let size = readU32(buf, offset);
  const name = readName(buf, offset + 4);
  if (size === 1) {
    if (offset + 16 > buf.byteLength) return null;
    const hi = readU32(buf, offset + 8);
    const lo = readU32(buf, offset + 12);
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
