import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { remuxTsToMp4 } from './remux.js';

const TS_FIXTURE = new URL(
  '../../node_modules/mux.js/test/segments/test-segment.ts',
  import.meta.url,
);

describe('remuxTsToMp4', () => {
  it('rewrites mux.js audio/video output into one moof per time range', async () => {
    const bytes = new Uint8Array(readFileSync(TS_FIXTURE));
    const out = await remuxTsToMp4(
      [
        { bytes, duration: 6 },
        { bytes, duration: 6 },
      ],
      () => {},
    );

    const top = topLevelBoxes(out);
    expect(top.map((box) => box.type)).toEqual(['ftyp', 'moov', 'moof', 'mdat', 'moof', 'mdat']);

    const moofs = top.filter((box) => box.type === 'moof');
    const mdats = top.filter((box) => box.type === 'mdat');
    expect(moofs).toHaveLength(2);
    expect(mdats).toHaveLength(2);

    for (let i = 0; i < moofs.length; i += 1) {
      const moof = moofs[i];
      const mdat = mdats[i];
      expect(readMfhdSequence(out, moof)).toBe(i + 1);
      expect(countChildBoxes(out, moof, 'traf')).toBe(2);
      expect(collectTfhdFlags(out, moof).every((flags) => flags & 0x020000)).toBe(true);

      const dataOffsets = collectTrunDataOffsets(out, moof);
      expect(dataOffsets).toHaveLength(2);
      for (const offset of dataOffsets) {
        expect(offset).toBeGreaterThanOrEqual(moof.size + 8);
        expect(offset).toBeLessThan(moof.size + mdat.size);
      }
    }
  });

  // QuickTime/AVFoundation computes a fragmented file's duration as
  // mvhd.duration + Σ(fragment durations), so a populated mvhd doubles the
  // reported length. The fix zeroes the base-movie header durations and
  // declares the real total in an mehd box injected into mvex.
  it('zeroes moov header durations and declares the total in mehd', async () => {
    const bytes = new Uint8Array(readFileSync(TS_FIXTURE));
    const out = await remuxTsToMp4(
      [
        { bytes, duration: 6 },
        { bytes, duration: 6 },
      ],
      () => {},
    );

    const moov = topLevelBoxes(out).find((box) => box.type === 'moov');
    expect(moov).toBeDefined();

    // mvhd v0 duration is at body + 16; must be zeroed.
    const mvhd = findBox(out, moov!, 'mvhd');
    expect(mvhd).toBeDefined();
    expect(readU32(out, mvhd!.start + 8 + 16)).toBe(0);

    // Every tkhd (v0 duration @ body+20) and mdhd (v0 duration @ body+16)
    // is zeroed too.
    const traks = childBoxes(out, moov!).filter((b) => b.type === 'trak');
    expect(traks.length).toBeGreaterThanOrEqual(1);
    for (const trak of traks) {
      const tkhd = findBox(out, trak, 'tkhd');
      expect(tkhd).toBeDefined();
      expect(readU32(out, tkhd!.start + 8 + 20)).toBe(0);
      const mdia = findBox(out, trak, 'mdia');
      const mdhd = findBox(out, mdia!, 'mdhd');
      expect(mdhd).toBeDefined();
      expect(readU32(out, mdhd!.start + 8 + 16)).toBe(0);
    }

    // mvex carries a v0 mehd whose fragment_duration (@ body+4) is the real
    // movie total — non-zero.
    const mvex = findBox(out, moov!, 'mvex');
    expect(mvex).toBeDefined();
    const mehd = findBox(out, mvex!, 'mehd');
    expect(mehd).toBeDefined();
    expect(out[mehd!.start + 8]).toBe(0); // version 0
    expect(readU32(out, mehd!.start + 8 + 4)).toBeGreaterThan(0);
  });
});

function childBoxes(buf: Uint8Array, parent: Box): Box[] {
  const boxes: Box[] = [];
  walkBoxes(buf, parent.start + 8, parent.end, (type, start, end) => {
    boxes.push({ type, start, end, size: end - start });
  });
  return boxes;
}

function findBox(buf: Uint8Array, parent: Box, type: string): Box | undefined {
  return childBoxes(buf, parent).find((b) => b.type === type);
}

interface Box {
  type: string;
  start: number;
  end: number;
  size: number;
}

type BoxVisitor = (type: string, start: number, end: number) => void;

function topLevelBoxes(buf: Uint8Array): Box[] {
  const boxes: Box[] = [];
  walkBoxes(buf, 0, buf.byteLength, (type, start, end) => {
    boxes.push({ type, start, end, size: end - start });
  });
  return boxes;
}

function readMfhdSequence(buf: Uint8Array, moof: Box): number | null {
  let sequence: number | null = null;
  walkBoxes(buf, moof.start + 8, moof.end, (type, start) => {
    if (type === 'mfhd') sequence = readU32(buf, start + 12);
  });
  return sequence;
}

function countChildBoxes(buf: Uint8Array, parent: Box, childType: string): number {
  let count = 0;
  walkBoxes(buf, parent.start + 8, parent.end, (type) => {
    if (type === childType) count += 1;
  });
  return count;
}

function collectTfhdFlags(buf: Uint8Array, moof: Box): number[] {
  const flags: number[] = [];
  walkBoxes(buf, moof.start + 8, moof.end, (type, start, end) => {
    if (type !== 'traf') return;
    walkBoxes(buf, start + 8, end, (subType, subStart) => {
      if (subType !== 'tfhd') return;
      const bodyStart = subStart + 8;
      flags.push((buf[bodyStart + 1] << 16) | (buf[bodyStart + 2] << 8) | buf[bodyStart + 3]);
    });
  });
  return flags;
}

function collectTrunDataOffsets(buf: Uint8Array, moof: Box): number[] {
  const offsets: number[] = [];
  walkBoxes(buf, moof.start + 8, moof.end, (type, start, end) => {
    if (type !== 'traf') return;
    walkBoxes(buf, start + 8, end, (subType, subStart) => {
      if (subType !== 'trun') return;
      const bodyStart = subStart + 8;
      const flags = (buf[bodyStart + 1] << 16) | (buf[bodyStart + 2] << 8) | buf[bodyStart + 3];
      expect(flags & 0x000001).toBeTruthy();
      offsets.push(readU32(buf, bodyStart + 8));
    });
  });
  return offsets;
}

function walkBoxes(buf: Uint8Array, start: number, end: number, visit: BoxVisitor): void {
  let i = start;
  while (i + 8 <= end) {
    const size = readU32(buf, i);
    if (size < 8 || size > end - i) break;
    visit(readName(buf, i + 4), i, i + size);
    i += size;
  }
}

function readU32(buf: Uint8Array, off: number): number {
  return ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
}

function readName(buf: Uint8Array, off: number): string {
  return String.fromCharCode(buf[off], buf[off + 1], buf[off + 2], buf[off + 3]);
}
