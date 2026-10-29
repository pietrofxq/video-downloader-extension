// lib.mjs — launch Chromium with the unpacked extension and drive it.
//
// Shared by `npm run harness` (launch.mjs) and the Playwright specs in e2e/.
// Google Chrome ignores --load-extension since Chrome 137, so this always runs
// Playwright's Chromium build (`channel: 'chromium'`), which also honours the
// flag in headless mode.

import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

const HARNESS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HARNESS_DIR, '..', '..');
export const DIST_DIR = path.join(REPO_ROOT, 'dist');
export const FIXTURES_DIR = path.join(HARNESS_DIR, 'fixtures');
export const GENERATED_DIR = path.join(FIXTURES_DIR, 'generated');
export const PROFILES_DIR = path.join(HARNESS_DIR, 'profiles');
export const OUT_DIR = path.join(HARNESS_DIR, 'out');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.bin': 'application/octet-stream',
};

/**
 * Serves scripts/harness/fixtures/ (plus hls.js out of node_modules) on
 * localhost. Honours Range requests, since the progressive path relies on them.
 */
export async function startFixtureServer({ port = 0 } = {}) {
  const hlsJs = path.join(REPO_ROOT, 'node_modules', 'hls.js', 'dist', 'hls.min.js');
  const server = createServer(async (req, res) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    let file;
    if (pathname === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    } else if (pathname === '/vendor/hls.min.js') {
      file = hlsJs;
    } else {
      const rel = decodeURIComponent(pathname).replace(/\/$/, '/index.html');
      file = path.join(FIXTURES_DIR, rel);
      if (!file.startsWith(FIXTURES_DIR + path.sep)) {
        res.writeHead(403).end();
        return;
      }
    }
    let body;
    try {
      body = await readFile(file);
    } catch {
      res.writeHead(404).end('not found');
      return;
    }
    const headers = {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
    };
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (range) {
      const [, from, to] = range;
      const start = from === '' ? Math.max(0, body.length - Number(to)) : Number(from);
      const end =
        from !== '' && to !== '' ? Math.min(Number(to), body.length - 1) : body.length - 1;
      if (start > end || start >= body.length) {
        res.writeHead(416, { 'content-range': `bytes */${body.length}` }).end();
        return;
      }
      res.writeHead(206, {
        ...headers,
        'content-range': `bytes ${start}-${end}/${body.length}`,
        'content-length': end - start + 1,
      });
      res.end(req.method === 'HEAD' ? undefined : body.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, { ...headers, 'content-length': body.length });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const actualPort = server.address().port;
  return {
    port: actualPort,
    url: `http://localhost:${actualPort}/`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const hasParsedEntry = (entries) =>
  entries.some((e) => e.kind !== 'hls' || e.isMaster || e.segmentCount != null || e.parseError);

/**
 * A master entry's rendition: the given `height`, or the highest quality
 * (resolution, then bandwidth), which is what the popup defaults to.
 */
export function pickVariant(entry, { height } = {}) {
  const variants = entry.variants ?? [];
  const heightOf = (v) => Number(v.resolution?.split('x')[1] ?? 0);
  if (height != null) return variants.find((v) => heightOf(v) === Number(height)) ?? null;
  const sorted = [...variants].sort(
    (a, b) => heightOf(b) - heightOf(a) || b.bandwidth - a.bandwidth,
  );
  return sorted[0] ?? null;
}

/**
 * Launches Chromium with dist/ loaded as an unpacked extension.
 *
 * `profile` names a directory under scripts/harness/profiles/ (cookies and
 * logins persist between runs), or '@temp' for a throwaway profile removed on
 * close. Console output from every context (sw, popup, offscreen, page) is
 * relayed to `onLog` with a timestamp and label.
 */
export async function launchExtension({
  headless = false,
  profile = 'scratch',
  fresh = false,
  dist = DIST_DIR,
  onLog = (...args) => console.log(...args),
} = {}) {
  if (!existsSync(path.join(dist, 'manifest.json'))) {
    throw new Error(`no extension build at ${dist} — run \`npm run build\` first`);
  }
  const temp = profile === '@temp';
  const userDataDir = temp
    ? await mkdtemp(path.join(os.tmpdir(), 'vdl-harness-'))
    : path.join(PROFILES_DIR, profile);
  if (fresh && !temp) await rm(userDataDir, { recursive: true, force: true });
  await mkdir(userDataDir, { recursive: true });

  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless,
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
    viewport: { width: 1280, height: 800 },
  });

  const t0 = Date.now();
  const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
  const log = (label, ...args) => onLog(`${stamp()} [${label}]`, ...args);

  const labelFor = (page) => {
    const url = page.url();
    if (url.startsWith('chrome-extension://')) return path.basename(new URL(url).pathname, '.html');
    return 'page';
  };
  const relay = (page) => {
    page.on('console', (m) => log(labelFor(page), m.type(), m.text()));
    page.on('pageerror', (err) => log(labelFor(page), 'pageerror', err.message));
  };
  context.pages().forEach(relay);
  context.on('page', relay);
  // The offscreen document is reported as a background page target.
  context.backgroundPages().forEach(relay);
  context.on('backgroundpage', relay);

  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  sw.on('console', (m) => log('sw', m.type(), m.text()));
  const extId = new URL(sw.url()).host;
  await sw.evaluate(() => chrome.storage.local.set({ logLevel: 'debug' }));

  // A plain resource document at the extension origin is a full extension
  // context (chrome.runtime / tabs / downloads) with none of the popup's side
  // effects — the cleanest place to send protocol messages from.
  const bridge = await context.newPage();
  await bridge.goto(`chrome-extension://${extId}/manifest.json`);
  const send = (type, payload) =>
    bridge.evaluate((msg) => chrome.runtime.sendMessage(msg), { type, payload });

  const harness = {
    context,
    sw,
    extId,
    bridge,
    userDataDir,
    log,
    stamp,
    send,

    /** Opens a URL in a new tab. */
    async open(url) {
      const page = await context.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      return page;
    },

    /** Chrome's tab id for a page (brings it to the front to find it). */
    async tabIdOf(page) {
      await page.bringToFront();
      return bridge.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        return tab?.id ?? null;
      });
    },

    /** The SW's canonical state for the tab showing `page` (GET_TAB_STATE). */
    async tabState(page) {
      const tabId = await harness.tabIdOf(page);
      const res = await send('GET_TAB_STATE', { tabId });
      if (!res?.ok) throw new Error(`GET_TAB_STATE failed for tab ${tabId}`);
      return { tabId, ...res.state };
    },

    /** Polls until `until(entries)` holds; by default, at least one parsed entry. */
    async waitForEntries(page, { timeout = 15_000, until = hasParsedEntry } = {}) {
      const deadline = Date.now() + timeout;
      let entries = [];
      while (Date.now() < deadline) {
        ({ entries } = await harness.tabState(page));
        if (until(entries)) return entries;
        await page.waitForTimeout(250);
      }
      throw new Error(`timed out waiting for media entries (have ${entries.length})`);
    },

    /**
     * Opens the popup in a tab, targeted at the tab showing `page`. The popup
     * finds its target via tabs.query({ active, currentWindow }), so the target
     * is made active and the popup tab reloaded.
     */
    async openPopupFor(page) {
      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
      await page.bringToFront();
      await popup.reload({ waitUntil: 'load' });
      await popup.waitForSelector('#content > *', { timeout: 10_000 }).catch(() => {});
      return popup;
    },

    async startDownload(mediaId, extra = {}) {
      const res = await send('START_DOWNLOAD', { mediaId, ...extra });
      if (!res?.ok) throw new Error(`START_DOWNLOAD failed: ${res?.error ?? 'no response'}`);
      return res; // { requestId, filename }
    },

    clearDownloads: () => bridge.evaluate(() => chrome.downloads.erase({})),

    /** The SW's persisted state for a download request (status, filename, ...). */
    async downloadState(requestId) {
      const { downloadStates } = await sw.evaluate(() =>
        chrome.storage.session.get('downloadStates'),
      );
      const list = Array.isArray(downloadStates)
        ? downloadStates
        : Object.values(downloadStates ?? {});
      return list.find((s) => s?.requestId === requestId) ?? null;
    },

    /**
     * Waits for the next chrome.downloads item to finish (clearDownloads()
     * first). With `requestId`, a SW-side error or cancel fails fast instead of
     * waiting out the timeout.
     */
    async waitForDownload({ requestId, timeout = 120_000 } = {}) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (requestId) {
          const state = await harness.downloadState(requestId);
          if (state?.status === 'error') {
            throw new Error(`download failed: ${state.errorCode}: ${state.errorMessage}`);
          }
          if (state?.status === 'canceled') throw new Error('download canceled');
        }
        const items = await bridge.evaluate(() => chrome.downloads.search({}));
        const done = items.find((i) => i.state === 'complete' || i.state === 'interrupted');
        if (done) return done;
        await bridge.waitForTimeout(500);
      }
      throw new Error('timed out waiting for the download to finish');
    },

    /**
     * Playwright routes chrome.downloads into a temp dir it deletes on close,
     * under a random name; copy the finished file out under its real name.
     */
    async saveDownload(item, filename, dir = OUT_DIR) {
      await mkdir(dir, { recursive: true });
      const dest = path.join(dir, path.basename(filename));
      await copyFile(item.filename, dest);
      return dest;
    },

    /**
     * Detect → START_DOWNLOAD → wait → copy out. `pick` chooses among the
     * tab's entries (default: first); `variant` is a height for master
     * playlists (default: highest). Other fields go into the START_DOWNLOAD
     * payload (`filename`, `variantUrl`, `audioTrackId`).
     */
    async download(page, options = {}) {
      const {
        pick = (entries) => entries[0],
        variant,
        dir = OUT_DIR,
        timeout,
        ...payload
      } = options;
      const entries = await harness.waitForEntries(page);
      const entry = pick(entries);
      if (!entry) throw new Error('no media entry to download');
      if (entry.isMaster && !payload.variantUrl) {
        const chosen = pickVariant(entry, { height: variant });
        if (!chosen) throw new Error(`no ${variant ? `${variant}p ` : ''}variant in ${entry.url}`);
        payload.variantUrl = chosen.url;
      }
      await harness.clearDownloads();
      const response = await harness.startDownload(entry.id, payload);
      const item = await harness.waitForDownload({ requestId: response.requestId, timeout });
      if (item.state !== 'complete') {
        throw new Error(`download ${item.state}: ${item.error ?? 'unknown reason'}`);
      }
      // The START_DOWNLOAD response guesses `.mp4`; the SW's saved state has
      // the name it actually handed to chrome.downloads (e.g. `.webm`).
      const state = await harness.downloadState(response.requestId);
      const saved = await harness.saveDownload(item, state?.filename ?? response.filename, dir);
      return { entry, response, item, path: saved };
    },

    async close() {
      await context.close();
      if (temp) await rm(userDataDir, { recursive: true, force: true });
    },
  };
  return harness;
}

/** Top-level box names of an MP4 file in order, read without loading the file. */
export async function topLevelBoxes(file) {
  const fh = await open(file, 'r');
  try {
    const { size: fileSize } = await fh.stat();
    const head = Buffer.alloc(16);
    const names = [];
    let off = 0;
    while (off + 8 <= fileSize) {
      await fh.read(head, 0, 16, off);
      let size = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      if (size === 1) size = Number(head.readBigUInt64BE(8));
      else if (size === 0) size = fileSize - off;
      if (size < 8 || !/^[\w ]{4}$/.test(type)) break;
      names.push(type);
      off += size;
    }
    return names;
  } finally {
    await fh.close();
  }
}

/** Container sanity check for a downloaded file; throws if it is not MP4 or WebM. */
export async function describeMediaFile(file) {
  const fh = await open(file, 'r');
  let bytes;
  const magic = Buffer.alloc(4);
  try {
    ({ size: bytes } = await fh.stat());
    await fh.read(magic, 0, 4, 0);
  } finally {
    await fh.close();
  }
  if (magic.readUInt32BE(0) === 0x1a45dfa3) {
    return { container: 'webm', bytes, boxes: [], fragments: 0 };
  }
  const boxes = await topLevelBoxes(file);
  if (boxes[0] !== 'ftyp' || !boxes.includes('moov')) {
    throw new Error(`not an MP4: boxes=${boxes.slice(0, 6).join(' ') || 'none'}`);
  }
  return { container: 'mp4', bytes, boxes, fragments: boxes.filter((b) => b === 'moof').length };
}
