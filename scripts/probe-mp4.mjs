#!/usr/bin/env node
// probe-mp4.mjs — walk a fragmented MP4 and print its box tree.
//
// Useful for manually verifying the remux output during debugging:
// expected shape is `ftyp moov (moof mdat)+` with two trafs per moof
// (one audio, one video) and a monotonically increasing mfhd seq.
//
// Usage:
//   node scripts/probe-mp4.mjs path/to/file.mp4 [--depth=N] [--limit-moofs=N]
//
// Examples:
//   node scripts/probe-mp4.mjs ~/Downloads/video.mp4
//   node scripts/probe-mp4.mjs out.mp4 --limit-moofs=3

import { readFileSync, statSync } from 'node:fs';
import { argv, exit } from 'node:process';

const args = argv.slice(2);
const path = args.find((a) => !a.startsWith('--'));
if (!path) {
  process.stderr.write('usage: probe-mp4.mjs <file.mp4> [--depth=N] [--limit-moofs=N]\n');
  exit(2);
}
const depthArg = args.find((a) => a.startsWith('--depth='));
const limitArg = args.find((a) => a.startsWith('--limit-moofs='));
const maxDepth = depthArg ? Number(depthArg.split('=')[1]) : 4;
const limitMoofs = limitArg ? Number(limitArg.split('=')[1]) : Infinity;

const buf = readFileSync(path);
const fileSize = statSync(path).size;

const CONTAINERS = new Set([
  'moov',
  'trak',
  'mdia',
  'minf',
  'stbl',
  'mvex',
  'moof',
  'traf',
  'edts',
  'dinf',
  'udta',
]);

function readU32(off) {
  return ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
}
function readU64(off) {
  // OK for sizes up to 2^53; box headers above that are vanishingly rare.
  const hi = readU32(off);
  const lo = readU32(off + 4);
  return hi * 2 ** 32 + lo;
}
function readName(off) {
  return String.fromCharCode(buf[off], buf[off + 1], buf[off + 2], buf[off + 3]);
}

function fmtBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)}MB`;
  return `${(n / 1024 ** 3).toFixed(2)}GB`;
}

let moofsSeen = 0;
const mfhdSeqs = [];
const trafCounts = []; // # of trafs per moof, in order

function walk(start, end, depth) {
  let i = start;
  while (i + 8 <= end) {
    let size = readU32(i);
    const name = readName(i + 4);
    let headerLen = 8;
    if (size === 1) {
      size = readU64(i + 8);
      headerLen = 16;
    } else if (size === 0) {
      size = end - i;
    }
    if (size < headerLen || size > end - i) {
      process.stderr.write(`!! corrupt box at offset ${i}: name=${name} size=${size}\n`);
      return;
    }

    if (name === 'moof') {
      if (moofsSeen >= limitMoofs) {
        // Skip its body; still account for it in the box-count line below.
      } else if (depth < maxDepth) {
        printBox(i, size, name, depth);
        // capture mfhd seq + trafs
        let trafN = 0;
        walkInto(i + headerLen, i + size, depth + 1, (childName, childOff, childSize) => {
          if (childName === 'mfhd') {
            mfhdSeqs.push(readU32(childOff + 8 + 4)); // body+4 = seq
          } else if (childName === 'traf') {
            trafN += 1;
          }
        });
        trafCounts.push(trafN);
      }
      moofsSeen += 1;
    } else if (CONTAINERS.has(name) && depth < maxDepth) {
      printBox(i, size, name, depth);
      walk(i + headerLen, i + size, depth + 1);
    } else if (moofsSeen < limitMoofs || name !== 'mdat') {
      printBox(i, size, name, depth);
    }
    i += size;
  }
}

function walkInto(start, end, depth, visit) {
  let i = start;
  while (i + 8 <= end) {
    let size = readU32(i);
    const name = readName(i + 4);
    let headerLen = 8;
    if (size === 1) {
      size = readU64(i + 8);
      headerLen = 16;
    } else if (size === 0) {
      size = end - i;
    }
    if (size < headerLen || size > end - i) return;
    visit(name, i, size);
    if (CONTAINERS.has(name) && depth < maxDepth) {
      printBox(i, size, name, depth);
      walk(i + headerLen, i + size, depth + 1);
    } else {
      printBox(i, size, name, depth);
    }
    i += size;
  }
}

function printBox(off, size, name, depth) {
  const pad = '  '.repeat(depth);
  console.log(`${pad}[${name}] @${off}  size=${fmtBytes(size)}`);
}

console.log(`file: ${path}  size=${fmtBytes(fileSize)}`);
console.log('---');
walk(0, buf.length, 0);
console.log('---');
console.log(`moofs total: ${moofsSeen}`);
if (mfhdSeqs.length > 0) {
  const monotonic = mfhdSeqs.every((v, i, a) => i === 0 || v > a[i - 1]);
  console.log(`mfhd sequence_numbers (first 6): ${mfhdSeqs.slice(0, 6).join(', ')}`);
  console.log(`mfhd monotonic: ${monotonic ? 'yes' : 'NO — fMP4 spec violation'}`);
}
if (trafCounts.length > 0) {
  const distinct = [...new Set(trafCounts)].sort((a, b) => a - b);
  console.log(`trafs per moof (distinct values): [${distinct.join(', ')}]`);
  if (distinct.length === 1 && distinct[0] === 2) {
    console.log('layout: combined audio+video moofs (good — VLC-friendly)');
  } else if (distinct.length === 1 && distinct[0] === 1) {
    console.log('layout: per-track moofs (mux.js raw shape — VLC may show blank intro)');
  } else {
    console.log('layout: mixed traf counts (unusual)');
  }
}
