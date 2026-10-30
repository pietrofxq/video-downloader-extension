import { defineConfig } from '@playwright/test';

// Browser-level smoke tests for the extension. Each spec launches its own
// Chromium through scripts/harness/lib.mjs, so there is no `use.browserName`
// here. Not part of `npm run check` — it needs a browser and ffmpeg.
export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/global-setup.ts',
  timeout: 120_000,
  fullyParallel: true,
  workers: 2,
  retries: 0,
  reporter: 'list',
  outputDir: 'scripts/harness/out/e2e',
});
