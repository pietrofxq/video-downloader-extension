import { makeFixtures } from '../scripts/harness/make-fixtures.mjs';

// Generate the ffmpeg fixtures once, before any worker starts.
export default async function globalSetup(): Promise<void> {
  await makeFixtures();
}
