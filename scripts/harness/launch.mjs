#!/usr/bin/env node
// launch.mjs — open the extension in a real Chromium and, optionally, download.
//
// Usage:
//   npm run harness -- [--url <url|fixture>] [--headless] [--download] [--variant <height>]
//                      [--keep-open] [--profile <name>] [--fresh] [--port <n>] [--wait <ms>]
//                      [--out <dir>]
//
// Examples:
//   npm run harness -- --url hls-aes-seq --headless --download
//   npm run harness -- --url https://www.youtube.com/watch?v=... --profile login --download
//   npm run harness -- --profile login --keep-open   # sign in to sites once; cookies persist
//
// A bare --url such as `hls-plain` opens that fixture page from the local
// server; a full URL opens that site. Output (screenshots, downloads) lands in
// scripts/harness/out/ unless --out is given.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  FIXTURES_DIR,
  OUT_DIR,
  describeMediaFile,
  launchExtension,
  startFixtureServer,
} from './lib.mjs';
import { makeFixtures } from './make-fixtures.mjs';

const args = parseArgs(process.argv.slice(2));
const headless = Boolean(args.headless);
const profile = typeof args.profile === 'string' ? args.profile : 'scratch';
const outDir = typeof args.out === 'string' ? path.resolve(args.out) : OUT_DIR;
const waitMs = Number(args.wait ?? 15_000);

await mkdir(outDir, { recursive: true });
const server = await startFixtureServer({ port: Number(args.port ?? 0) });
const target = resolveUrl(args.url, server.url);
if (target.startsWith(server.url)) await makeFixtures();
console.log(`fixture server: ${server.url}`);

const h = await launchExtension({ headless, profile, fresh: Boolean(args.fresh) });
let failed = false;
try {
  console.log(`extension ${h.extId} loaded (profile: ${profile}, headless: ${headless})`);
  const page = await h.open(target);
  let entries = [];
  try {
    entries = await h.waitForEntries(page, { timeout: waitMs });
  } catch {
    console.log(`no media detected within ${waitMs} ms`);
  }
  console.log(`entries for ${target}:\n${summarize(entries)}`);

  const popup = await h.openPopupFor(page);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await popup.screenshot({ path: path.join(outDir, `popup-${stamp}.png`) });
  await page.screenshot({ path: path.join(outDir, `page-${stamp}.png`) });
  console.log(`popup:\n${indent(await popup.innerText('body'))}`);

  if (args.download) {
    if (!entries.length) throw new Error('nothing to download');
    const filename = typeof args.filename === 'string' ? args.filename : undefined;
    const variant = typeof args.variant === 'string' ? Number(args.variant) : undefined;
    const result = await h.download(page, { dir: outDir, filename, variant });
    console.log(`saved ${result.path}`);
    console.log(JSON.stringify(await describeMediaFile(result.path)));
    const probe = await ffprobe(result.path);
    if (probe) console.log(`ffprobe:\n${indent(probe)}`);
  }

  if (args['keep-open']) {
    console.log('browser stays open — press Ctrl+C to close');
    await new Promise((resolve) => process.once('SIGINT', resolve));
  }
} catch (err) {
  failed = true;
  console.error('harness failed:', err?.message ?? err);
} finally {
  await h.close();
  await server.close();
}
process.exit(failed ? 1 : 0);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const [key, inline] = arg.slice(2).split('=', 2);
    if (inline !== undefined) out[key] = inline;
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[key] = argv[++i];
    else out[key] = true;
  }
  return out;
}

function resolveUrl(arg, serverUrl) {
  if (typeof arg !== 'string') return serverUrl;
  if (/^https?:\/\//.test(arg)) return arg;
  const name = arg.replace(/\.html$/, '');
  if (!existsSync(path.join(FIXTURES_DIR, `${name}.html`))) {
    throw new Error(`unknown fixture page: ${arg}`);
  }
  return `${serverUrl}${name}.html`;
}

function summarize(entries) {
  if (!entries.length) return '  (none)';
  return entries
    .map((e) => {
      let extra = '';
      if (e.parseError) extra = `parseError=${e.parseError}`;
      else if (e.isMaster) extra = `${e.variants?.length ?? 0} variants`;
      else if (e.segmentCount != null)
        extra = `${e.segmentCount} segments, ${e.totalDuration ?? '?'} s`;
      return `  ${e.kind}  adapter=${e.adapterId}  ${e.url}  ${extra}${e.drm ? '  DRM' : ''}`;
    })
    .join('\n');
}

function indent(text) {
  return text
    .trim()
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n');
}

async function ffprobe(file) {
  try {
    const { stdout } = await promisify(execFile)('ffprobe', [
      ...['-v', 'error', '-of', 'compact=p=0'],
      ...['-show_entries', 'format=duration:stream=codec_type,codec_name,width,height'],
      file,
    ]);
    return stdout.trim();
  } catch {
    return null;
  }
}
