import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { remuxTsToMp4 } from './remux.js';

const TS_FIXTURE = new URL('../../node_modules/mux.js/test/segments/test-segment.ts', import.meta.url);

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
});

function topLevelBoxes(buf) {
  const boxes = [];
  walkBoxes(buf, 0, buf.byteLength, (type, start, end) => {
    boxes.push({ type, start, end, size: end - start });
  });
  return boxes;
}

function readMfhdSequence(buf, moof) {
  let sequence = null;
  walkBoxes(buf, moof.start + 8, moof.end, (type, start) => {
    if (type === 'mfhd') sequence = readU32(buf, start + 12);
  });
  return sequence;
}

function countChildBoxes(buf, parent, childType) {
  let count = 0;
  walkBoxes(buf, parent.start + 8, parent.end, (type) => {
    if (type === childType) count += 1;
  });
  return count;
}

function collectTfhdFlags(buf, moof) {
  const flags = [];
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

function collectTrunDataOffsets(buf, moof) {
  const offsets = [];
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

function walkBoxes(buf, start, end, visit) {
  let i = start;
  while (i + 8 <= end) {
    const size = readU32(buf, i);
    if (size < 8 || size > end - i) break;
    visit(readName(buf, i + 4), i, i + size);
    i += size;
  }
}

function readU32(buf, off) {
  return (
    ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0
  );
}

function readName(buf, off) {
  return String.fromCharCode(buf[off], buf[off + 1], buf[off + 2], buf[off + 3]);
}
