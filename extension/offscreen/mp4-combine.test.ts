import { describe, it, expect } from 'vitest';

import { combineFmp4, memorySource } from './mp4-combine.js';

// ---------- synthetic fMP4 builder ----------
//
// combineFmp4 de-fragments two single-track fMP4 inputs into one plain
// (non-fragmented) MP4. To test it we build the smallest legal single-
// track fMP4 the muxer actually parses: a moov whose trak carries a real
// box tree (tkhd, optional edts, mdia → mdhd/hdlr/minf → stbl → stsd) plus
// mvex/trex, followed by (moof + mdat) fragments whose trun describes each
// sample's duration / size / flags / composition offset.

function te(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function u32(v: number): Uint8Array {
  const b = new Uint8Array(4);
  // `>>>` coerces to uint32, so negative values serialize as two's complement.
  b[0] = (v >>> 24) & 0xff;
  b[1] = (v >>> 16) & 0xff;
  b[2] = (v >>> 8) & 0xff;
  b[3] = v & 0xff;
  return b;
}

function box(type: string, ...children: Uint8Array[]): Uint8Array {
  let total = 8;
  for (const c of children) total += c.byteLength;
  const out = new Uint8Array(total);
  out.set(u32(total), 0);
  out.set(te(type), 4);
  let off = 8;
  for (const c of children) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

function makeMvhd(timescale: number, durationTicks: number, nextTrackId: number): Uint8Array {
  const body = new Uint8Array(100);
  body.set(u32(timescale), 12);
  body.set(u32(durationTicks), 16);
  body.set(u32(0x00010000), 20);
  body[24] = 0x01;
  body.set(u32(0x00010000), 32);
  body.set(u32(0x00010000), 48);
  body.set(u32(0x40000000), 68);
  body.set(u32(nextTrackId), 96);
  return box('mvhd', body);
}

function makeTkhd(trackId: number, durationTicks: number): Uint8Array {
  const body = new Uint8Array(84);
  body[3] = 0x03;
  body.set(u32(trackId), 12);
  body.set(u32(durationTicks), 20);
  body.set(u32(0x00010000), 40);
  body.set(u32(0x00010000), 56);
  body.set(u32(0x40000000), 76);
  return box('tkhd', body);
}

function makeMdhd(timescale: number, durationTicks: number): Uint8Array {
  const body = new Uint8Array(24);
  body.set(u32(timescale), 12);
  body.set(u32(durationTicks), 16);
  body[20] = 0x55;
  body[21] = 0xc4;
  return box('mdhd', body);
}

function makeHdlr(handlerType: string): Uint8Array {
  // fullbox(4) + pre_defined(4) + handler_type(4) + reserved(12) + name\0
  const body = new Uint8Array(25);
  body.set(te(handlerType), 8);
  return box('hdlr', body);
}

function makeStsd(format: string): Uint8Array {
  // fullbox(4) + entry_count(4)=1 + one minimal sample-entry box.
  const entry = box(format, new Uint8Array(8));
  return box('stsd', concat(u32(0), u32(1), entry));
}

function makeStbl(format: string): Uint8Array {
  // Only stsd matters — the input's sample tables are empty in real fMP4.
  return box('stbl', makeStsd(format));
}

function makeMinf(format: string): Uint8Array {
  return box('minf', makeStbl(format));
}

function makeMdia(
  timescale: number,
  durationTicks: number,
  handlerType: string,
  format: string,
): Uint8Array {
  return box('mdia', makeMdhd(timescale, durationTicks), makeHdlr(handlerType), makeMinf(format));
}

function makeElst(entries: Array<{ segDur: number; mediaTime: number }>): Uint8Array {
  const body = new Uint8Array(8 + entries.length * 12);
  body.set(u32(entries.length), 4);
  let p = 8;
  for (const e of entries) {
    body.set(u32(e.segDur), p);
    body.set(u32(e.mediaTime), p + 4);
    body.set(u32(0x00010000), p + 8); // media_rate 1.0
    p += 12;
  }
  return box('elst', body);
}

function makeTrex(trackId: number): Uint8Array {
  const body = new Uint8Array(24);
  body.set(u32(trackId), 4);
  body.set(u32(1), 8);
  return box('trex', body);
}

interface Sample {
  dur: number;
  size: number;
  cto?: number;
  /** Defaults to true for the first sample, false otherwise (keyframe-led). */
  sync?: boolean;
}

// One (moof + mdat) fragment. tfhd sets default-base-is-moof; the trun
// declares per-sample duration/size/flags(+cto). data_offset is patched to
// point at the mdat payload (relative to the moof, per default-base-is-moof).
function makeFragment(trackId: number, seq: number, tfdt: number, samples: Sample[]): Uint8Array {
  const anyCto = samples.some((s) => (s.cto ?? 0) !== 0);
  const anyNeg = samples.some((s) => (s.cto ?? 0) < 0);

  const mfhd = box('mfhd', concat(u32(0), u32(seq)));

  // tfhd: version 0, flags = default-base-is-moof (0x020000).
  const tfhd = box('tfhd', concat(new Uint8Array([0, 0x02, 0, 0]), u32(trackId)));
  const tfdtBox = box('tfdt', concat(u32(0), u32(tfdt)));

  // trun flags: data-offset + duration + size + flags (+ cto).
  let flags = 0x000001 | 0x000100 | 0x000200 | 0x000400;
  if (anyCto) flags |= 0x000800;
  const version = anyNeg ? 1 : 0;
  const perSample = 4 * (anyCto ? 4 : 3);
  const trunBody = new Uint8Array(8 + 4 + samples.length * perSample);
  trunBody[0] = version;
  trunBody.set(u32(flags).subarray(1), 1); // 3-byte flags
  trunBody.set(u32(samples.length), 4);
  trunBody.set(u32(0), 8); // data_offset placeholder — patched below
  let p = 12;
  samples.forEach((s, i) => {
    const sync = s.sync ?? i === 0;
    trunBody.set(u32(s.dur), p);
    trunBody.set(u32(s.size), p + 4);
    trunBody.set(u32(sync ? 0 : 0x00010000), p + 8);
    if (anyCto) trunBody.set(u32(s.cto ?? 0), p + 12);
    p += perSample;
  });
  const trun = box('trun', trunBody);

  const traf = box('traf', tfhd, tfdtBox, trun);
  const moof = box('moof', mfhd, traf);

  // data_offset (relative to moof start) = moof size + mdat header (8).
  const dataOffset = moof.byteLength + 8;
  // Locate the trun's data_offset field within the assembled moof and patch.
  // moof = [hdr8][mfhd][traf: hdr8 + tfhd + tfdt + (trun: hdr8 + verflags4 + count4 + dataoff4 ...)]
  const trunDataOffsetPos =
    8 + mfhd.byteLength + 8 + tfhd.byteLength + tfdtBox.byteLength + 8 + 4 + 4;
  moof.set(u32(dataOffset), trunDataOffsetPos);

  let payloadLen = 0;
  for (const s of samples) payloadLen += s.size;
  const payload = new Uint8Array(payloadLen);
  // Fill with a per-fragment marker so payload placement is checkable.
  payload.fill((trackId * 64 + seq) & 0xff);
  const mdat = box('mdat', payload);

  return concat(moof, mdat);
}

function makeFmp4(args: {
  trackId: number;
  trackTimescale: number;
  movieTimescale: number;
  handlerType: string;
  format: string;
  fragments: Array<{ tfdt: number; samples: Sample[] }>;
  edts?: Array<{ segDur: number; mediaTime: number }>;
}): Uint8Array {
  const { trackId, trackTimescale, movieTimescale, handlerType, format, fragments, edts } = args;
  const trak = box(
    'trak',
    makeTkhd(trackId, 0),
    ...(edts ? [box('edts', makeElst(edts))] : []),
    makeMdia(trackTimescale, 0, handlerType, format),
  );
  const moov = box(
    'moov',
    makeMvhd(movieTimescale, 0, trackId + 1),
    trak,
    box('mvex', makeTrex(trackId)),
  );
  const ftyp = box('ftyp', te('iso5'), u32(512), te('iso5'), te('iso6'), te('mp41'));
  let seq = 1;
  const frags = fragments.map((f) => makeFragment(trackId, seq++, f.tfdt, f.samples));
  return concat(ftyp, moov, ...frags);
}

// ---------- in-memory FileSystemFileHandle ----------

interface MockFile {
  bytes: Uint8Array;
  handle: FileSystemFileHandle;
}

function makeMockFile(): MockFile {
  const file: { bytes: Uint8Array } = { bytes: new Uint8Array(0) };
  const writable = {
    async write(data: Uint8Array<ArrayBuffer> | BufferSource): Promise<void> {
      const chunk = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBufferLike);
      const next = new Uint8Array(file.bytes.byteLength + chunk.byteLength);
      next.set(file.bytes, 0);
      next.set(chunk, file.bytes.byteLength);
      file.bytes = next;
    },
    async close(): Promise<void> {},
  };
  const handle = {
    kind: 'file',
    name: 'mock',
    async createWritable(): Promise<unknown> {
      return writable;
    },
  } as unknown as FileSystemFileHandle;
  return {
    get bytes(): Uint8Array {
      return file.bytes;
    },
    handle,
  };
}

// ---------- box walking helpers (for assertions) ----------

function readU32(buf: Uint8Array, off: number): number {
  return ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
}

function readName(buf: Uint8Array, off: number): string {
  return String.fromCharCode(buf[off], buf[off + 1], buf[off + 2], buf[off + 3]);
}

interface BoxRef {
  name: string;
  start: number;
  end: number;
  bodyStart: number;
}

function readBoxSize(buf: Uint8Array, off: number): { size: number; bodyStart: number } {
  const size = readU32(buf, off);
  if (size === 1) {
    const hi = readU32(buf, off + 8);
    const lo = readU32(buf, off + 12);
    return { size: hi * 0x100000000 + lo, bodyStart: off + 16 };
  }
  return { size, bodyStart: off + 8 };
}

function children(buf: Uint8Array, start: number, end: number): BoxRef[] {
  const out: BoxRef[] = [];
  let i = start;
  while (i + 8 <= end) {
    const { size, bodyStart } = readBoxSize(buf, i);
    if (size < 8 || i + size > end) break;
    out.push({ name: readName(buf, i + 4), start: i, end: i + size, bodyStart });
    i += size;
  }
  return out;
}

function topBoxes(buf: Uint8Array): BoxRef[] {
  return children(buf, 0, buf.byteLength);
}

function find(boxes: BoxRef[], name: string): BoxRef | undefined {
  return boxes.find((b) => b.name === name);
}

function trakByHandler(buf: Uint8Array, handler: string): BoxRef | undefined {
  const moov = find(topBoxes(buf), 'moov');
  if (!moov) return undefined;
  for (const trak of children(buf, moov.bodyStart, moov.end).filter((b) => b.name === 'trak')) {
    const mdia = find(children(buf, trak.bodyStart, trak.end), 'mdia');
    if (!mdia) continue;
    const hdlr = find(children(buf, mdia.bodyStart, mdia.end), 'hdlr');
    if (hdlr && readName(buf, hdlr.bodyStart + 8) === handler) return trak;
  }
  return undefined;
}

function stblOf(buf: Uint8Array, trak: BoxRef): BoxRef[] {
  const mdia = find(children(buf, trak.bodyStart, trak.end), 'mdia')!;
  const minf = find(children(buf, mdia.bodyStart, mdia.end), 'minf')!;
  const stbl = find(children(buf, minf.bodyStart, minf.end), 'stbl')!;
  return children(buf, stbl.bodyStart, stbl.end);
}

function tkhdDuration(buf: Uint8Array, trak: BoxRef): number {
  const tkhd = find(children(buf, trak.bodyStart, trak.end), 'tkhd')!;
  return readU32(buf, tkhd.bodyStart + 20); // v0 duration offset
}

function tkhdTrackId(buf: Uint8Array, trak: BoxRef): number {
  const tkhd = find(children(buf, trak.bodyStart, trak.end), 'tkhd')!;
  return readU32(buf, tkhd.bodyStart + 12);
}

// ---------- common fixtures ----------

// Video: track ts 30000, movie ts 30000 (matches output). Two fragments,
// B-frame composition offsets, keyframe-led so stss has 2 entries.
function videoInput(
  opts: { edts?: Array<{ segDur: number; mediaTime: number }> } = {},
): Uint8Array {
  return makeFmp4({
    trackId: 1,
    trackTimescale: 30000,
    movieTimescale: 30000,
    handlerType: 'vide',
    format: 'avc1',
    edts: opts.edts,
    fragments: [
      {
        tfdt: 0,
        samples: [
          { dur: 1001, size: 5000, cto: 2002, sync: true },
          { dur: 1001, size: 1200, cto: 0, sync: false },
          { dur: 1001, size: 1300, cto: 1001, sync: false },
        ],
      },
      {
        tfdt: 3003,
        samples: [
          { dur: 1001, size: 4800, cto: 2002, sync: true },
          { dur: 1001, size: 1100, cto: 0, sync: false },
        ],
      },
    ],
  });
}

// Audio: track ts 44100, movie ts 44100 (DIFFERS from the video/output
// movie ts of 30000). All samples sync, no composition offsets.
function audioInput(
  opts: { edts?: Array<{ segDur: number; mediaTime: number }> } = {},
): Uint8Array {
  return makeFmp4({
    trackId: 1,
    trackTimescale: 44100,
    movieTimescale: 44100,
    handlerType: 'soun',
    format: 'mp4a',
    edts: opts.edts,
    fragments: [
      {
        tfdt: 0,
        samples: [
          { dur: 1024, size: 400, sync: true },
          { dur: 1024, size: 410, sync: true },
        ],
      },
      { tfdt: 2048, samples: [{ dur: 1024, size: 420, sync: true }] },
    ],
  });
}

describe('combineFmp4', () => {
  it('produces a non-fragmented ftyp + moov + mdat with two traks', async () => {
    const file = makeMockFile();
    const { bytes } = await combineFmp4(
      memorySource(videoInput()),
      memorySource(audioInput()),
      file.handle,
    );
    expect(bytes).toBe(file.bytes.byteLength);

    const top = topBoxes(file.bytes).map((b) => b.name);
    expect(top).toEqual(['ftyp', 'moov', 'mdat']);
    expect(top).not.toContain('moof');

    const moov = find(topBoxes(file.bytes), 'moov')!;
    const traks = children(file.bytes, moov.bodyStart, moov.end).filter((b) => b.name === 'trak');
    expect(traks).toHaveLength(2);
    // mvex/trex must be gone — this is no longer fragmented.
    expect(find(children(file.bytes, moov.bodyStart, moov.end), 'mvex')).toBeUndefined();

    const video = trakByHandler(file.bytes, 'vide')!;
    const audio = trakByHandler(file.bytes, 'soun')!;
    expect(tkhdTrackId(file.bytes, video)).toBe(1);
    expect(tkhdTrackId(file.bytes, audio)).toBe(2);
  });

  it('populates flat sample tables (stsz / stsc / co64) per track', async () => {
    const file = makeMockFile();
    await combineFmp4(memorySource(videoInput()), memorySource(audioInput()), file.handle);

    const video = trakByHandler(file.bytes, 'vide')!;
    const vstbl = stblOf(file.bytes, video);
    const stsz = find(vstbl, 'stsz')!;
    expect(readU32(file.bytes, stsz.bodyStart + 8)).toBe(5); // 3 + 2 samples
    const co64 = find(vstbl, 'co64')!;
    expect(readU32(file.bytes, co64.bodyStart + 4)).toBe(2); // 2 chunks (2 fragments)
    expect(find(vstbl, 'stco')).toBeUndefined(); // 64-bit offsets only

    const audio = trakByHandler(file.bytes, 'soun')!;
    const astbl = stblOf(file.bytes, audio);
    expect(readU32(file.bytes, find(astbl, 'stsz')!.bodyStart + 8)).toBe(3); // 2 + 1
  });

  it('rescales the audio track duration into the video movie timescale', async () => {
    // Audio media duration = 3072 ticks @ 44100; output movie ts = 30000.
    // tkhd.duration must be 3072/44100*30000 ≈ 2090, NOT the raw 3072.
    const file = makeMockFile();
    await combineFmp4(memorySource(videoInput()), memorySource(audioInput()), file.handle);

    const moov = find(topBoxes(file.bytes), 'moov')!;
    const mvhd = find(children(file.bytes, moov.bodyStart, moov.end), 'mvhd')!;
    const movieTs = readU32(file.bytes, mvhd.bodyStart + 12);
    expect(movieTs).toBe(30000); // output keeps the video's movie timescale

    const audio = trakByHandler(file.bytes, 'soun')!;
    const expected = Math.round((3072 / 44100) * 30000);
    expect(tkhdDuration(file.bytes, audio)).toBe(expected);
    expect(expected).not.toBe(3072); // proves a real conversion happened

    // mdhd stays in the track's own timescale.
    const mdia = find(children(file.bytes, audio.bodyStart, audio.end), 'mdia')!;
    const mdhd = find(children(file.bytes, mdia.bodyStart, mdia.end), 'mdhd')!;
    expect(readU32(file.bytes, mdhd.bodyStart + 12)).toBe(44100);
    expect(readU32(file.bytes, mdhd.bodyStart + 16)).toBe(3072);
  });

  it('keeps the video edit list verbatim and rescales the audio edit list', async () => {
    // Video movie ts == output movie ts → ratio 1, edts untouched.
    // Audio movie ts 44100 → output 30000 → segment_duration scaled by 30000/44100.
    const file = makeMockFile();
    await combineFmp4(
      memorySource(videoInput({ edts: [{ segDur: 3003, mediaTime: 1001 }] })),
      memorySource(audioInput({ edts: [{ segDur: 3072, mediaTime: 0 }] })),
      file.handle,
    );

    const video = trakByHandler(file.bytes, 'vide')!;
    const vedts = find(children(file.bytes, video.bodyStart, video.end), 'edts')!;
    const velst = find(children(file.bytes, vedts.bodyStart, vedts.end), 'elst')!;
    expect(readU32(file.bytes, velst.bodyStart + 8)).toBe(3003); // unchanged
    expect(readU32(file.bytes, velst.bodyStart + 12)).toBe(1001); // media_time unchanged

    const audio = trakByHandler(file.bytes, 'soun')!;
    const aedts = find(children(file.bytes, audio.bodyStart, audio.end), 'edts')!;
    const aelst = find(children(file.bytes, aedts.bodyStart, aedts.end), 'elst')!;
    expect(readU32(file.bytes, aelst.bodyStart + 8)).toBe(Math.round(3072 * (30000 / 44100)));
    expect(readU32(file.bytes, aelst.bodyStart + 12)).toBe(0); // media_time untouched
  });

  it('emits ctts + stss for video and omits both for all-sync audio', async () => {
    const file = makeMockFile();
    await combineFmp4(memorySource(videoInput()), memorySource(audioInput()), file.handle);

    const vstbl = stblOf(file.bytes, trakByHandler(file.bytes, 'vide')!);
    expect(find(vstbl, 'ctts')).toBeDefined(); // B-frame composition offsets
    const stss = find(vstbl, 'stss')!;
    expect(stss).toBeDefined();
    expect(readU32(file.bytes, stss.bodyStart + 4)).toBe(2); // 2 keyframes (1 per fragment)

    const astbl = stblOf(file.bytes, trakByHandler(file.bytes, 'soun')!);
    expect(find(astbl, 'ctts')).toBeUndefined(); // no composition offsets
    expect(find(astbl, 'stss')).toBeUndefined(); // all samples sync
  });

  it('promotes ctts to version 1 when composition offsets are negative', async () => {
    const video = makeFmp4({
      trackId: 1,
      trackTimescale: 30000,
      movieTimescale: 30000,
      handlerType: 'vide',
      format: 'avc1',
      fragments: [
        {
          tfdt: 0,
          samples: [
            { dur: 1001, size: 5000, cto: 0, sync: true },
            { dur: 1001, size: 1200, cto: -1001, sync: false },
          ],
        },
      ],
    });
    const file = makeMockFile();
    await combineFmp4(memorySource(video), memorySource(audioInput()), file.handle);
    const vstbl = stblOf(file.bytes, trakByHandler(file.bytes, 'vide')!);
    const ctts = find(vstbl, 'ctts')!;
    expect(file.bytes[ctts.bodyStart]).toBe(1); // version byte
  });

  it('places sample payload at the offset its co64 entry advertises', async () => {
    const file = makeMockFile();
    await combineFmp4(memorySource(videoInput()), memorySource(audioInput()), file.handle);

    // First video chunk: marker = (trackId*64 + seq) & 0xff = (64 + 1) = 65.
    const vstbl = stblOf(file.bytes, trakByHandler(file.bytes, 'vide')!);
    const co64 = find(vstbl, 'co64')!;
    const firstOffset =
      readU32(file.bytes, co64.bodyStart + 8) * 0x100000000 +
      readU32(file.bytes, co64.bodyStart + 12);
    expect(file.bytes[firstOffset]).toBe(65);
  });

  it('rejects an input that is missing moov', async () => {
    const justFtyp = box('ftyp', te('iso5'), u32(0), te('iso5'), te('iso6'), te('mp41'));
    const file = makeMockFile();
    await expect(
      combineFmp4(memorySource(justFtyp), memorySource(audioInput()), file.handle),
    ).rejects.toThrow(/moov/);
  });

  it('honors an abort signal before work starts', async () => {
    const ctrl = new AbortController();
    ctrl.abort(new DOMException('aborted', 'AbortError'));
    const file = makeMockFile();
    await expect(
      combineFmp4(
        memorySource(videoInput()),
        memorySource(audioInput()),
        file.handle,
        undefined,
        ctrl.signal,
      ),
    ).rejects.toThrow(/aborted/);
  });
});
