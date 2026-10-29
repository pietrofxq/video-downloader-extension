import { expect, test } from '@playwright/test';

import { describeMediaFile, launchExtension, startFixtureServer } from '../scripts/harness/lib.mjs';

// HEADED=1 shows the browser; the default is headless.
const HEADLESS = process.env.HEADED !== '1';

async function downloadFixture(name: string) {
  const info = test.info();
  const lines: string[] = [];
  const server = await startFixtureServer();
  const h = await launchExtension({
    headless: HEADLESS,
    profile: '@temp',
    onLog: (...args: unknown[]) => lines.push(args.join(' ')),
  });
  try {
    const page = await h.open(`${server.url}${name}.html`);
    const result = await h.download(page, { dir: info.outputPath() });
    return { ...result, info: await describeMediaFile(result.path) };
  } finally {
    await info.attach('harness-log', { body: lines.join('\n'), contentType: 'text/plain' });
    await h.close();
    await server.close();
  }
}

for (const name of ['hls-plain', 'hls-aes-iv', 'hls-aes-seq', 'hls-master']) {
  test(`${name}: detects the stream and downloads a fragmented MP4`, async () => {
    const { entry, item, info } = await downloadFixture(name);
    expect(entry.kind).toBe('hls');
    expect(item.state).toBe('complete');
    expect(info.container).toBe('mp4');
    expect(info.boxes.slice(0, 2)).toEqual(['ftyp', 'moov']);
    expect(info.fragments).toBeGreaterThanOrEqual(4);
    expect(info.bytes).toBeGreaterThan(100_000);
  });
}

test('progressive-mp4: downloads the file as-is', async () => {
  const { item, info } = await downloadFixture('progressive-mp4');
  expect(item.state).toBe('complete');
  expect(info.container).toBe('mp4');
  expect(info.boxes).toContain('mdat');
  expect(info.bytes).toBeGreaterThan(100_000);
});

test('progressive-webm: downloads the file as-is', async () => {
  const { item, info } = await downloadFixture('progressive-webm');
  expect(item.state).toBe('complete');
  expect(info.container).toBe('webm');
  expect(info.bytes).toBeGreaterThan(50_000);
});
