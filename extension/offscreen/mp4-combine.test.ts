import { describe, it, expect } from 'vitest';

import { combineFmp4, memorySource } from './mp4-combine.js';

// ---------- synthetic fMP4 builder ----------
//
// The combine muxer's correctness is about box-tree manipulation:
// renumber track_IDs, interleave moofs in time order, patch mfhd
// sequence numbers. Real fMP4 from googlevideo would test the same
// invariants but at much higher cost. We build the smallest legal
// box-tree that has the structural features combineFmp4 inspects
// (mvhd, tkhd, mdhd, mvex.trex, moof+mdat with tfhd / tfdt / trun)
// and assert the post-combine layout.

function te(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function u32(v: number): Uint8Array {
  const b = new Uint8Array(4);
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

// mvhd v0: version+flags(4) + creation(4) + modification(4) +
// timescale(4) + duration(4) + rate(4) + volume(2) + reserved(10) +
// matrix(36) + pre_defined(24) + next_track_ID(4) = 100 bytes body.
function makeMvhd(timescale: number, durationTicks: number, nextTrackId: number): Uint8Array {
  const body = new Uint8Array(100);
  // version=0, flags=0 already
  body.set(u32(timescale), 12);
  body.set(u32(durationTicks), 16);
  body.set(u32(0x00010000), 20); // rate = 1.0
  body[24] = 0x01; // volume high byte (1.0)
  // identity matrix at +32 (36 bytes); only the three fixed values matter
  body.set(u32(0x00010000), 32); // a
  body.set(u32(0x00010000), 48); // e
  body.set(u32(0x40000000), 68); // w
  body.set(u32(nextTrackId), 96);
  return box('mvhd', body);
}

// tkhd v0: version+flags(4) + creation(4) + modification(4) +
// track_ID(4) + reserved(4) + duration(4) + reserved(8) + layer(2) +
// altgroup(2) + volume(2) + reserved(2) + matrix(36) + width(4) +
// height(4) = 84 bytes body.
function makeTkhd(trackId: number, durationTicks: number): Uint8Array {
  const body = new Uint8Array(84);
  body[3] = 0x03; // flags: track_enabled + track_in_movie
  body.set(u32(trackId), 12);
  body.set(u32(durationTicks), 20);
  body.set(u32(0x00010000), 40); // matrix a
  body.set(u32(0x00010000), 56); // matrix e
  body.set(u32(0x40000000), 76); // matrix w
  return box('tkhd', body);
}

// mdhd v0: version+flags(4) + creation(4) + modification(4) +
// timescale(4) + duration(4) + language(2) + pre_defined(2) = 24 bytes.
function makeMdhd(timescale: number, durationTicks: number): Uint8Array {
  const body = new Uint8Array(24);
  body.set(u32(timescale), 12);
  body.set(u32(durationTicks), 16);
  // language: packed 5-bit ISO 639-2 chars → "und" = 0x55C4
  body[20] = 0x55;
  body[21] = 0xc4;
  return box('mdhd', body);
}

function makeTrak(trackId: number, trackTimescale: number, durationTicks: number): Uint8Array {
  // Combine cares about tkhd.track_ID + mdia.mdhd.timescale. The
  // smallest legal trak just needs tkhd + mdia (containing mdhd).
  return box(
    'trak',
    makeTkhd(trackId, durationTicks),
    box('mdia', makeMdhd(trackTimescale, durationTicks)),
  );
}

function makeTrex(trackId: number, defaultSampleDuration = 0): Uint8Array {
  // trex body: version+flags(4) + track_ID(4) + default_sample_description_index(4) +
  // default_sample_duration(4) + default_sample_size(4) + default_sample_flags(4).
  const body = new Uint8Array(24);
  body.set(u32(trackId), 4);
  body.set(u32(1), 8); // default sample description index
  body.set(u32(defaultSampleDuration), 12);
  return box('trex', body);
}

function makeMoov(
  trackId: number,
  trackTimescale: number,
  durationTicks: number,
  opts: { trexDefaultSampleDuration?: number } = {},
): Uint8Array {
  return box(
    'moov',
    makeMvhd(1000, durationTicks, trackId + 1),
    makeTrak(trackId, trackTimescale, durationTicks),
    box('mvex', makeTrex(trackId, opts.trexDefaultSampleDuration ?? 0)),
  );
}

// mfhd body: version+flags(4) + sequence_number(4).
function makeMfhd(seq: number): Uint8Array {
  const body = new Uint8Array(8);
  body.set(u32(seq), 4);
  return box('mfhd', body);
}

// tfhd body: version+flags(4) + track_ID(4). flags=0 (nothing else
// declared) — combine only reads track_ID + flags, so the minimum
// shape is fine.
function makeTfhd(trackId: number): Uint8Array {
  const body = new Uint8Array(8);
  body.set(u32(trackId), 4);
  return box('tfhd', body);
}

// tfdt v0 body: version+flags(4) + baseMediaDecodeTime(4).
function makeTfdt(decodeTime: number): Uint8Array {
  const body = new Uint8Array(8);
  body.set(u32(decodeTime), 4);
  return box('tfdt', body);
}

// trun body: version+flags(4) + sample_count(4). Minimal trun
// (no per-sample fields) — combine doesn't inspect them.
function makeTrun(sampleCount: number): Uint8Array {
  const body = new Uint8Array(8);
  body.set(u32(sampleCount), 4);
  return box('trun', body);
}

function makeMoofMdat(trackId: number, seq: number, tfdt: number, payload: Uint8Array): Uint8Array {
  const moof = box(
    'moof',
    makeMfhd(seq),
    box('traf', makeTfhd(trackId), makeTfdt(tfdt), makeTrun(1)),
  );
  const mdat = box('mdat', payload);
  return concat(moof, mdat);
}

// Build a "largesize" box: 4-byte size=1, type, 8-byte largesize,
// payload. Real-world YouTube serves some mdat boxes this way even
// when the body would fit in a 32-bit size. parseFmp4Structure must
// handle it without tripping the "malformed mdat" check.
function largeBox(type: string, payload: Uint8Array): Uint8Array {
  const total = 16 + payload.byteLength;
  const out = new Uint8Array(total);
  out.set(u32(1), 0); // size=1 sentinel
  out.set(te(type), 4);
  // 8-byte big-endian largesize.
  out.set(u32(0), 8); // high 32 bits
  out.set(u32(total), 12); // low 32 bits — total fits in 32 bits in the test
  out.set(payload, 16);
  return out;
}

// Box of arbitrary type — used to inject styp/free/skip between
// moof and mdat to verify the pairing tolerates intervening boxes.
function makeMoofWithIntervening(
  trackId: number,
  seq: number,
  tfdt: number,
  payload: Uint8Array,
  intervening: Uint8Array[],
): Uint8Array {
  const moof = box(
    'moof',
    makeMfhd(seq),
    box('traf', makeTfhd(trackId), makeTfdt(tfdt), makeTrun(1)),
  );
  const mdat = box('mdat', payload);
  return concat(moof, ...intervening, mdat);
}

function makeFmp4(
  trackId: number,
  trackTimescale: number,
  fragments: Array<{ tfdt: number; payload: Uint8Array }>,
  opts: {
    /** Override the mvhd.duration ticks (default: derived from last tfdt + 1000). */
    mvhdDurationTicks?: number;
    /** Set mvex.trex.default_sample_duration so duration derivation has a fallback. */
    trexDefaultSampleDuration?: number;
  } = {},
): Uint8Array {
  const lastTfdt = fragments.length > 0 ? fragments[fragments.length - 1].tfdt : 0;
  const totalTicks = opts.mvhdDurationTicks ?? lastTfdt + 1000;
  const parts: Uint8Array[] = [
    box('ftyp', te('iso5'), u32(512), te('iso5'), te('iso6'), te('mp41')),
    makeMoov(trackId, trackTimescale, totalTicks, {
      trexDefaultSampleDuration: opts.trexDefaultSampleDuration,
    }),
  ];
  let seq = 1;
  for (const frag of fragments) {
    parts.push(makeMoofMdat(trackId, seq, frag.tfdt, frag.payload));
    seq += 1;
  }
  return concat(...parts);
}

// ---------- in-memory FileSystemFileHandle ----------
//
// combineFmp4 writes through the standard OPFS handle API. For tests
// we mimic the parts it touches: createWritable() + .write() + .close()
// and the ability to read the bytes back at the end.

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
    // combineFmp4 only exercises createWritable.
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
}

function readBoxSize(buf: Uint8Array, off: number): number {
  const size = readU32(buf, off);
  if (size === 1) {
    // 64-bit largesize follows the type field.
    const hi = readU32(buf, off + 8);
    const lo = readU32(buf, off + 12);
    return hi * 0x100000000 + lo;
  }
  return size;
}

function topBoxes(buf: Uint8Array): BoxRef[] {
  const out: BoxRef[] = [];
  let i = 0;
  while (i + 8 <= buf.byteLength) {
    const size = readBoxSize(buf, i);
    if (size < 8 || size > buf.byteLength - i) break;
    out.push({ name: readName(buf, i + 4), start: i, end: i + size });
    i += size;
  }
  return out;
}

function childBoxes(buf: Uint8Array, parent: BoxRef): BoxRef[] {
  const out: BoxRef[] = [];
  let i = parent.start + 8;
  while (i + 8 <= parent.end) {
    const size = readU32(buf, i);
    if (size < 8 || size > parent.end - i) break;
    out.push({ name: readName(buf, i + 4), start: i, end: i + size });
    i += size;
  }
  return out;
}

function findFirst(boxes: BoxRef[], name: string): BoxRef | undefined {
  return boxes.find((b) => b.name === name);
}

describe('combineFmp4', () => {
  it('emits ftyp + moov with two traks + interleaved moofs', async () => {
    // Video: track_ID=1, two fragments at tfdt=0 and tfdt=1000.
    const video = makeFmp4(1, 90000, [
      { tfdt: 0, payload: te('VID-A-payload') },
      { tfdt: 1000, payload: te('VID-B-payload') },
    ]);
    // Audio: also track_ID=1 (each input is single-track). Combine
    // should renumber it to 2.
    const audio = makeFmp4(1, 48000, [
      { tfdt: 0, payload: te('AUD-A-payload') },
      { tfdt: 500, payload: te('AUD-B-payload') },
    ]);

    const file = makeMockFile();
    const result = await combineFmp4(memorySource(video), memorySource(audio), file.handle);
    expect(result.bytes).toBeGreaterThan(0);
    expect(file.bytes.byteLength).toBe(result.bytes);

    const top = topBoxes(file.bytes);
    // Layout: ftyp, moov, then 4 (moof+mdat) pairs interleaved.
    expect(top[0].name).toBe('ftyp');
    expect(top[1].name).toBe('moov');
    const tail = top.slice(2).map((b) => b.name);
    expect(tail).toEqual(['moof', 'mdat', 'moof', 'mdat', 'moof', 'mdat', 'moof', 'mdat']);
  });

  it('renumbers the audio track_ID and patches tfhd.track_ID in audio moofs', async () => {
    const video = makeFmp4(1, 90000, [{ tfdt: 0, payload: te('VID') }]);
    const audio = makeFmp4(1, 48000, [{ tfdt: 0, payload: te('AUD') }]);

    const file = makeMockFile();
    await combineFmp4(memorySource(video), memorySource(audio), file.handle);

    const top = topBoxes(file.bytes);
    const moov = findFirst(top, 'moov');
    expect(moov).toBeDefined();
    const moovChildren = childBoxes(file.bytes, moov!);
    const traks = moovChildren.filter((b) => b.name === 'trak');
    expect(traks).toHaveLength(2);

    // Track IDs from each trak's tkhd should be distinct.
    const trackIds = traks.map((trak) => {
      const tkhd = findFirst(childBoxes(file.bytes, trak), 'tkhd');
      // tkhd body: version+flags(4) + creation+modification(8) + track_ID(4).
      return readU32(file.bytes, tkhd!.start + 8 + 12);
    });
    expect(new Set(trackIds).size).toBe(2);
    expect(trackIds).toContain(1);
    expect(trackIds).toContain(2);

    // mvex should have two trex children — one per renumbered track.
    const mvex = findFirst(moovChildren, 'mvex');
    expect(mvex).toBeDefined();
    const trexes = childBoxes(file.bytes, mvex!).filter((b) => b.name === 'trex');
    expect(trexes).toHaveLength(2);
    const trexTrackIds = trexes.map((trex) => readU32(file.bytes, trex.start + 8 + 4));
    expect(new Set(trexTrackIds)).toEqual(new Set([1, 2]));

    // Both moofs' tfhd.track_ID values across the file should cover {1, 2}.
    const moofTracks = top
      .filter((b) => b.name === 'moof')
      .map((moof) => {
        const traf = findFirst(childBoxes(file.bytes, moof), 'traf');
        const tfhd = findFirst(childBoxes(file.bytes, traf!), 'tfhd');
        return readU32(file.bytes, tfhd!.start + 8 + 4);
      });
    expect(new Set(moofTracks)).toEqual(new Set([1, 2]));
  });

  it('assigns monotonic mfhd.sequence_number across video+audio moofs', async () => {
    const video = makeFmp4(1, 90000, [
      { tfdt: 0, payload: te('V1') },
      { tfdt: 1000, payload: te('V2') },
    ]);
    const audio = makeFmp4(1, 48000, [
      { tfdt: 0, payload: te('A1') },
      { tfdt: 1000, payload: te('A2') },
    ]);

    const file = makeMockFile();
    await combineFmp4(memorySource(video), memorySource(audio), file.handle);

    const top = topBoxes(file.bytes);
    const moofs = top.filter((b) => b.name === 'moof');
    const sequences = moofs.map((moof) => {
      const mfhd = findFirst(childBoxes(file.bytes, moof), 'mfhd');
      // mfhd body: version+flags(4) + sequence_number(4).
      return readU32(file.bytes, mfhd!.start + 8 + 4);
    });
    expect(sequences).toEqual([1, 2, 3, 4]);
  });

  it('interleaves fragments in tfdt time order', async () => {
    // Track timescales differ — video at 90k, audio at 48k. The
    // first audio fragment at tfdt=0/48k=0s lands at the same time as
    // the first video fragment; video wins the tie. Then video's
    // tfdt=9000/90k=0.1s precedes audio's tfdt=4800/48k=0.1s, again
    // video wins. Net order should be V0, A0, V1, A1.
    const video = makeFmp4(1, 90000, [
      { tfdt: 0, payload: te('VID-0') },
      { tfdt: 9000, payload: te('VID-1') },
    ]);
    const audio = makeFmp4(1, 48000, [
      { tfdt: 0, payload: te('AUD-0') },
      { tfdt: 4800, payload: te('AUD-1') },
    ]);

    const file = makeMockFile();
    await combineFmp4(memorySource(video), memorySource(audio), file.handle);

    // Read the mdat payloads in file order; assert ordering.
    const top = topBoxes(file.bytes);
    const mdats = top.filter((b) => b.name === 'mdat');
    const decoded = mdats.map((m) =>
      new TextDecoder().decode(file.bytes.subarray(m.start + 8, m.end)),
    );
    expect(decoded).toEqual(['VID-0', 'AUD-0', 'VID-1', 'AUD-1']);
  });

  it('bumps mvhd.next_track_ID past the highest assigned track', async () => {
    const video = makeFmp4(1, 90000, [{ tfdt: 0, payload: te('V') }]);
    const audio = makeFmp4(1, 48000, [{ tfdt: 0, payload: te('A') }]);

    const file = makeMockFile();
    await combineFmp4(memorySource(video), memorySource(audio), file.handle);

    const top = topBoxes(file.bytes);
    const moov = findFirst(top, 'moov');
    const mvhd = findFirst(childBoxes(file.bytes, moov!), 'mvhd');
    // mvhd v0: next_track_ID is the last 4 bytes of the box body.
    // body = box payload (no size+type prefix); last 4 bytes of box.
    const nextTrackId = readU32(file.bytes, mvhd!.end - 4);
    expect(nextTrackId).toBe(3); // audio at 2 → next is 3
  });

  it('derives mvhd duration from fragments when source mvhd.duration is zero', async () => {
    // Both inputs ship mvhd.duration = 0 (the case generic DASH
    // packagers produce). Combine must walk fragments and end up
    // with a non-zero combined mvhd.duration. With trex default
    // sample duration = 3000 ticks @ 90k → 1 sample per fragment
    // → last fragment at tfdt=9000 + 3000 = 12000 ticks ≈ 0.133s →
    // combined mvhd in movie timescale (1000) ≈ 133 ticks.
    const video = makeFmp4(
      1,
      90000,
      [
        { tfdt: 0, payload: te('V0') },
        { tfdt: 9000, payload: te('V1') },
      ],
      { mvhdDurationTicks: 0, trexDefaultSampleDuration: 3000 },
    );
    // Audio mvhd also zero; shorter than video — combine picks the max.
    const audio = makeFmp4(1, 48000, [{ tfdt: 0, payload: te('A0') }], {
      mvhdDurationTicks: 0,
      trexDefaultSampleDuration: 1024,
    });

    const file = makeMockFile();
    await combineFmp4(memorySource(video), memorySource(audio), file.handle);

    const top = topBoxes(file.bytes);
    const moov = findFirst(top, 'moov');
    const mvhd = findFirst(childBoxes(file.bytes, moov!), 'mvhd');
    // mvhd v0: duration is at body offset +16 (4 bytes).
    const durTicks = readU32(file.bytes, mvhd!.start + 8 + 16);
    expect(durTicks).toBeGreaterThan(0);
    // Video duration in seconds: (9000 + 3000) / 90000 = 0.1333…
    // Audio duration in seconds: (0 + 1024) / 48000 = 0.0213…
    // Combined mvhd in movie timescale (1000): round(0.1333… * 1000) ≈ 133.
    expect(durTicks).toBeGreaterThanOrEqual(130);
    expect(durTicks).toBeLessThanOrEqual(140);
  });

  it('derives mvhd duration when source mvhd.duration is the 0xFFFFFFFF sentinel', async () => {
    // The fMP4 "unknown duration, derive from samples" sentinel.
    // Without the fallback, VLC reads it literally as ~57 days.
    const video = makeFmp4(1, 90000, [{ tfdt: 0, payload: te('V0') }], {
      mvhdDurationTicks: 0xffffffff,
      trexDefaultSampleDuration: 9000,
    });
    const audio = makeFmp4(1, 48000, [{ tfdt: 0, payload: te('A0') }], {
      mvhdDurationTicks: 0xffffffff,
      trexDefaultSampleDuration: 4800,
    });

    const file = makeMockFile();
    await combineFmp4(memorySource(video), memorySource(audio), file.handle);

    const top = topBoxes(file.bytes);
    const moov = findFirst(top, 'moov');
    const mvhd = findFirst(childBoxes(file.bytes, moov!), 'mvhd');
    const durTicks = readU32(file.bytes, mvhd!.start + 8 + 16);
    // Both inputs have 1 sample × default duration ÷ track timescale = 0.1s.
    // Combined mvhd at movie timescale 1000 → 100 ticks.
    expect(durTicks).toBeGreaterThanOrEqual(95);
    expect(durTicks).toBeLessThanOrEqual(105);
  });

  it('rejects an input that is missing moov', async () => {
    const justFtyp = box('ftyp', te('iso5'), u32(0), te('iso5'), te('iso6'), te('mp41'));
    const audio = makeFmp4(1, 48000, [{ tfdt: 0, payload: te('A') }]);

    const file = makeMockFile();
    await expect(
      combineFmp4(memorySource(justFtyp), memorySource(audio), file.handle),
    ).rejects.toThrow(/moov/);
  });

  it('honors abort signal before fetch', async () => {
    const video = makeFmp4(1, 90000, [{ tfdt: 0, payload: te('V') }]);
    const audio = makeFmp4(1, 48000, [{ tfdt: 0, payload: te('A') }]);

    const ctrl = new AbortController();
    ctrl.abort(new DOMException('aborted', 'AbortError'));
    const file = makeMockFile();
    await expect(
      combineFmp4(memorySource(video), memorySource(audio), file.handle, undefined, ctrl.signal),
    ).rejects.toThrow(/aborted/);
  });

  it('handles a 64-bit largesize mdat (size==1)', async () => {
    // Hand-build a fmp4 where the single moof's mdat uses largesize.
    // YouTube ships this on some high-bitrate AVC tracks.
    const moof = box('moof', makeMfhd(1), box('traf', makeTfhd(1), makeTfdt(0), makeTrun(1)));
    const mdat = largeBox('mdat', te('VIDEO-LARGESIZE'));
    const totalTicks = 1000;
    const video = concat(
      box('ftyp', te('iso5'), u32(512), te('iso5'), te('iso6'), te('mp41')),
      makeMoov(1, 90000, totalTicks),
      moof,
      mdat,
    );
    const audio = makeFmp4(1, 48000, [{ tfdt: 0, payload: te('AUD') }]);

    const file = makeMockFile();
    await combineFmp4(memorySource(video), memorySource(audio), file.handle);

    // Output should contain both moofs + mdats — proof the parser
    // walked past the largesize mdat without throwing.
    const top = topBoxes(file.bytes);
    const tail = top.slice(2).map((b) => b.name);
    expect(tail).toEqual(['moof', 'mdat', 'moof', 'mdat']);
  });

  it('tolerates intervening styp / free / skip boxes between moof and mdat', async () => {
    // Construct a fragment with `styp` and `free` boxes wedged
    // between the moof and its mdat. The spec doesn't strictly
    // require moof-mdat adjacency; some packagers insert these.
    const styp = box('styp', te('msdh'), u32(0), te('msdh'));
    const free = box('free', te('xxxx'));
    const moofMdat = makeMoofWithIntervening(1, 1, 0, te('VID'), [styp, free]);
    const totalTicks = 1000;
    const video = concat(
      box('ftyp', te('iso5'), u32(512), te('iso5'), te('iso6'), te('mp41')),
      makeMoov(1, 90000, totalTicks),
      moofMdat,
    );
    const audio = makeFmp4(1, 48000, [{ tfdt: 0, payload: te('AUD') }]);

    const file = makeMockFile();
    await combineFmp4(memorySource(video), memorySource(audio), file.handle);
    // Pairing succeeded — output has both moofs + mdats.
    const top = topBoxes(file.bytes);
    const tail = top.slice(2).map((b) => b.name);
    expect(tail).toEqual(['moof', 'mdat', 'moof', 'mdat']);
  });

  it('walks past mdats whose body is larger than any header-read chunk (4K regression)', async () => {
    // Reported field bug after Phase A landed: at 1440p+ the
    // streaming walker stopped at the first moof and the parser
    // threw "moof at offset N has no matching mdat (top-level box
    // sequence: ftyp,moov,sidx,moof)". The cause was the walker
    // bounds-checked a box's totalSize against the buffer slice
    // it had just read for the header — fine in unit tests where
    // small fixtures get returned whole, but wrong for OPFS-backed
    // sources that strictly return only the requested bytes.
    //
    // Regression: fabricate a fixture with an mdat body sized
    // bigger than any header-buffer slice the walker plausibly
    // takes (we read 16 bytes per header; the mdat body here is
    // 200 KB) plus a second moof+mdat behind it. If the walker
    // mis-handles the large box it'll stop after the first
    // mdat and the second pair won't pair up — same error shape
    // as the field report.
    const bigPayload = new Uint8Array(200 * 1024).fill(0x42);
    const video = concat(
      box('ftyp', te('iso5'), u32(512), te('iso5'), te('iso6'), te('mp41')),
      makeMoov(1, 90000, 2000),
      makeMoofMdat(1, 1, 0, bigPayload),
      makeMoofMdat(1, 2, 1000, te('VID2')),
    );
    const audio = makeFmp4(1, 48000, [
      { tfdt: 0, payload: te('AUD1') },
      { tfdt: 1000, payload: te('AUD2') },
    ]);

    const file = makeMockFile();
    await combineFmp4(memorySource(video), memorySource(audio), file.handle);
    // All four pairs must reach the output. Pre-fix the walker
    // would have stopped after the large mdat and the second pair
    // would have been missing.
    const top = topBoxes(file.bytes);
    const tail = top.slice(2).map((b) => b.name);
    expect(tail).toEqual(['moof', 'mdat', 'moof', 'mdat', 'moof', 'mdat', 'moof', 'mdat']);
  });

  it('throws an informative error when a moof has no matching mdat', async () => {
    // A moof followed by EOF — no mdat to pair with.
    const orphanMoof = box('moof', makeMfhd(1), box('traf', makeTfhd(1), makeTfdt(0), makeTrun(1)));
    const totalTicks = 1000;
    const video = concat(
      box('ftyp', te('iso5'), u32(512), te('iso5'), te('iso6'), te('mp41')),
      makeMoov(1, 90000, totalTicks),
      orphanMoof,
    );
    const audio = makeFmp4(1, 48000, [{ tfdt: 0, payload: te('AUD') }]);

    const file = makeMockFile();
    await expect(
      combineFmp4(memorySource(video), memorySource(audio), file.handle),
    ).rejects.toThrow(/no matching mdat/);
  });
});
