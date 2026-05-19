import * as esbuild from 'esbuild';
import { cp, mkdir, rm, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, 'extension');
const OUT = path.join(__dirname, 'dist');
const WATCH = process.argv.includes('--watch');

const ENTRIES = {
  // Content scripts MUST be IIFE — they're not loaded as modules.
  'content/page-content.js': { entry: 'content/page-content.js', format: 'iife' },
  'content/frame-content.js': { entry: 'content/frame-content.js', format: 'iife' },
  // SW is loaded with type: "module" in manifest, so ESM is fine, but we
  // still bundle to a single file for simplicity.
  'background/service-worker.js': { entry: 'background/service-worker.js', format: 'esm' },
  // Popup uses <script type="module"> — keep as ESM bundle.
  'popup/popup.js': { entry: 'popup/popup.js', format: 'esm' },
  // Offscreen is a stub for v0.1 but treated the same way.
  'offscreen/offscreen.js': { entry: 'offscreen/offscreen.js', format: 'esm' },
};

const STATIC_FILES = [
  'manifest.json',
  'popup/popup.html',
  'popup/popup.css',
  'offscreen/offscreen.html',
];

const STATIC_DIRS = ['icons', 'vendor'];

async function pathExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function copyStatic() {
  for (const f of STATIC_FILES) {
    const from = path.join(SRC, f);
    const to = path.join(OUT, f);
    await mkdir(path.dirname(to), { recursive: true });
    await cp(from, to);
  }
  for (const d of STATIC_DIRS) {
    const from = path.join(SRC, d);
    if (!(await pathExists(from))) continue;
    const to = path.join(OUT, d);
    await cp(from, to, { recursive: true });
  }
}

async function buildOnce() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  const tasks = Object.entries(ENTRIES).map(([outFile, { entry, format }]) =>
    esbuild.build({
      entryPoints: [path.join(SRC, entry)],
      outfile: path.join(OUT, outFile),
      bundle: true,
      format,
      target: ['chrome120'],
      platform: 'browser',
      sourcemap: 'inline',
      logLevel: 'info',
    }),
  );

  await Promise.all(tasks);
  await copyStatic();
  console.log('Built', Object.keys(ENTRIES).length, 'entries to', path.relative(__dirname, OUT));
  await listOutputs(OUT);
}

async function listOutputs(dir, prefix = '') {
  const items = await readdir(dir, { withFileTypes: true });
  for (const it of items.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix + it.name;
    if (it.isDirectory()) {
      await listOutputs(path.join(dir, it.name), rel + '/');
    } else {
      console.log('  ', rel);
    }
  }
}

async function watch() {
  const contexts = await Promise.all(
    Object.entries(ENTRIES).map(([outFile, { entry, format }]) =>
      esbuild.context({
        entryPoints: [path.join(SRC, entry)],
        outfile: path.join(OUT, outFile),
        bundle: true,
        format,
        target: ['chrome120'],
        platform: 'browser',
        sourcemap: 'inline',
        logLevel: 'info',
      }),
    ),
  );
  await copyStatic();
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('esbuild watching… (static assets copied once; re-run build for static changes)');
}

if (WATCH) {
  await watch();
} else {
  await buildOnce();
}
