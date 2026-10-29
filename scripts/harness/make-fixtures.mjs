// make-fixtures.mjs — generate the local media fixtures with ffmpeg.
//
// Output goes to scripts/harness/fixtures/generated/ (gitignored). Everything
// is synthetic (test pattern + sine tone), so nothing copyrighted lands in the
// repo and no network is needed. `--force` regenerates.

import { execFile } from 'node:child_process';
import { createCipheriv } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { GENERATED_DIR } from './lib.mjs';

// Bump when the generated set changes so stale fixtures get rebuilt.
export const FIXTURE_VERSION = 1;
const MARKER = path.join(GENERATED_DIR, '.complete');
const run = promisify(execFile);
const ffmpeg = (...args) =>
  run('ffmpeg', ['-y', '-loglevel', 'error', ...args], { cwd: GENERATED_DIR });

// HLS AES-128 is CBC with PKCS7 padding; a fixed key keeps fixtures reproducible.
const KEY = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
const EXPLICIT_IV = Buffer.from('fedcba9876543210fedcba9876543210', 'hex');

export function fixturesReady() {
  try {
    return existsSync(MARKER) && readFileSync(MARKER, 'utf8').trim() === String(FIXTURE_VERSION);
  } catch {
    return false;
  }
}

export async function makeFixtures({ force = false } = {}) {
  if (!force && fixturesReady()) return false;
  await rm(GENERATED_DIR, { recursive: true, force: true });
  for (const d of ['hls-plain', 'hls-aes-iv', 'hls-aes-seq', 'hls-master', 'progressive']) {
    await mkdir(path.join(GENERATED_DIR, d), { recursive: true });
  }

  // 8 s of test pattern + 440 Hz tone, keyframe every 2 s so segments cut cleanly.
  await ffmpeg(
    ...['-f', 'lavfi', '-i', 'testsrc2=duration=8:size=640x360:rate=25'],
    ...['-f', 'lavfi', '-i', 'sine=frequency=440:duration=8'],
    ...['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p'],
    ...['-g', '50', '-keyint_min', '50', '-sc_threshold', '0'],
    ...['-c:a', 'aac', '-b:a', '64k', '-shortest', '-movflags', '+faststart'],
    'source.mp4',
  );

  // Plain HLS VOD: stream-copy into 2 s MPEG-TS segments.
  await ffmpeg(
    ...['-i', 'source.mp4', '-c', 'copy', '-f', 'hls'],
    ...['-hls_time', '2', '-hls_list_size', '0', '-hls_playlist_type', 'vod'],
    ...['-hls_segment_filename', 'hls-plain/seg%03d.ts'],
    'hls-plain/index.m3u8',
  );

  // AES-128 variants derived from the plain segments.
  await encryptPlaylist('hls-aes-iv', { iv: EXPLICIT_IV });
  await encryptPlaylist('hls-aes-seq', { mediaSequence: 7 });

  // Master playlist with two renditions (180p + 360p), flat layout.
  await ffmpeg(
    ...['-i', 'source.mp4', '-map', '0:v', '-map', '0:a', '-map', '0:v', '-map', '0:a'],
    ...['-c:v', 'libx264', '-preset', 'veryfast', '-g', '50', '-keyint_min', '50'],
    ...['-sc_threshold', '0', '-s:v:0', '320x180', '-b:v:0', '200k', '-b:v:1', '600k'],
    ...['-c:a', 'aac', '-b:a', '64k', '-f', 'hls'],
    ...['-hls_time', '2', '-hls_list_size', '0', '-hls_playlist_type', 'vod'],
    ...['-var_stream_map', 'v:0,a:0 v:1,a:1', '-master_pl_name', 'master.m3u8'],
    ...['-hls_segment_filename', 'hls-master/v%v_seg%03d.ts'],
    'hls-master/v%v_index.m3u8',
  );

  // Progressive files.
  await copyFile(
    path.join(GENERATED_DIR, 'source.mp4'),
    path.join(GENERATED_DIR, 'progressive', 'sample.mp4'),
  );
  await ffmpeg(
    ...['-i', 'source.mp4', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8'],
    ...['-b:v', '300k', '-c:a', 'libopus', '-b:a', '48k'],
    'progressive/sample.webm',
  );

  await writeFile(MARKER, `${FIXTURE_VERSION}\n`);
  return true;
}

/**
 * Encrypts the plain playlist's segments. Without `iv`, the key tag omits IV=
 * so the IV is the segment's media sequence number (RFC 8216 §5.2); a non-zero
 * `mediaSequence` makes an index-vs-sequence mix-up decrypt to noise.
 */
async function encryptPlaylist(name, { iv, mediaSequence = 0 }) {
  const src = path.join(GENERATED_DIR, 'hls-plain');
  const dst = path.join(GENERATED_DIR, name);
  const lines = (await readFile(path.join(src, 'index.m3u8'), 'utf8')).split('\n');
  const out = [];
  let index = 0;
  for (const line of lines) {
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      out.push(`#EXT-X-MEDIA-SEQUENCE:${mediaSequence}`);
      continue;
    }
    if (line.startsWith('#EXTINF:') && index === 0) {
      const ivAttr = iv ? `,IV=0x${iv.toString('hex')}` : '';
      out.push(`#EXT-X-KEY:METHOD=AES-128,URI="key.bin"${ivAttr}`);
    }
    if (line.endsWith('.ts')) {
      const cipher = createCipheriv('aes-128-cbc', KEY, iv ?? sequenceIv(mediaSequence + index));
      const plain = await readFile(path.join(src, line));
      await writeFile(path.join(dst, line), Buffer.concat([cipher.update(plain), cipher.final()]));
      index += 1;
    }
    out.push(line);
  }
  await writeFile(path.join(dst, 'key.bin'), KEY);
  await writeFile(path.join(dst, 'index.m3u8'), out.join('\n'));
}

function sequenceIv(seq) {
  const buf = Buffer.alloc(16);
  buf.writeBigUInt64BE(BigInt(seq), 8);
  return buf;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const made = await makeFixtures({ force: process.argv.includes('--force') });
  console.log(
    made ? `fixtures generated in ${GENERATED_DIR}` : 'fixtures up to date (--force to regenerate)',
  );
}
