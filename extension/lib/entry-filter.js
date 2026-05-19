// Hide entries whose URL appears in another entry's variants or alternates
// list. variants are the master's #EXT-X-STREAM-INF playlists (different
// video qualities); alternates are the master's #EXT-X-MEDIA renditions
// (subtitles, alternate audio). Both get fetched by the player and detected
// independently by webRequest, so both must collapse under the master.
//
// Shared by the popup (rendering) and the SW (badge counting) so the two
// always agree on what counts as a user-visible "row".

export function filterTopLevel(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return [];
  const hidden = new Set();
  for (const e of entries) {
    if (Array.isArray(e.variants)) for (const v of e.variants) hidden.add(v.url);
    if (Array.isArray(e.alternates)) for (const a of e.alternates) hidden.add(a.url);
  }
  return entries.filter((e) => !hidden.has(e.url));
}
