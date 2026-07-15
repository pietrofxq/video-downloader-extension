// Hide entries whose URL appears in another entry's variants or alternates
// list. variants are the master's #EXT-X-STREAM-INF playlists (different
// video qualities); alternates are the master's #EXT-X-MEDIA renditions
// (subtitles, alternate audio). Both get fetched by the player and detected
// independently by webRequest, so both must collapse under the master.
//
// Shared by the popup (rendering) and the SW (badge counting) so the two
// always agree on what counts as a user-visible "row".

import type { MediaEntry } from './types.ts';

// Passive `.mpd` captures have no parse or download pipeline yet
// (mpd-parser is post-v1.1): nothing ever populates their variants, so
// the popup would render them stuck on "Loading…" with a disabled
// Download button forever — usually right next to the working HLS row
// for the same video. Hide them until DASH manifests are supported.
// Adapter-supplied dash entries (YouTube) always carry non-empty
// variants, and DRM-flagged entries stay visible so the row can say
// "DRM-protected" instead of silently disappearing.
function isDisplayable(e: MediaEntry): boolean {
  if (e.kind !== 'dash') return true;
  if (e.drm === true) return true;
  return Array.isArray(e.variants) && e.variants.length > 0;
}

export function filterTopLevel(entries: MediaEntry[]): MediaEntry[] {
  if (!Array.isArray(entries) || entries.length === 0) return [];
  const hidden = new Set<string>();
  for (const e of entries) {
    if (Array.isArray(e.variants)) for (const v of e.variants) hidden.add(v.url);
    if (Array.isArray(e.alternates)) for (const a of e.alternates) hidden.add(a.url);
  }
  return entries.filter((e) => !hidden.has(e.url) && isDisplayable(e));
}
