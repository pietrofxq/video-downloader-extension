import { Parser } from 'm3u8-parser';
import type { HlsAlternate, HlsVariant, ParsedHlsManifest } from './types.ts';

function resolveUri(uri: string | undefined, baseUrl: string): string {
  try {
    return new URL(uri ?? '', baseUrl).toString();
  } catch {
    return uri ?? '';
  }
}

// Pull non-variant rendition URIs out of mediaGroups (#EXT-X-MEDIA).
// Hotmart and most HLS sources list subtitle / alternate-audio playlists
// here; the player fetches them, webRequest sees them, and without this
// extraction they'd show as separate top-level entries in the popup.
function collectAlternates(
  mediaGroups:
    | Record<
        string,
        Record<string, Record<string, { uri?: string; language?: string; default?: boolean }>>
      >
    | undefined,
  baseUrl: string,
): HlsAlternate[] {
  const out: HlsAlternate[] = [];
  if (!mediaGroups || typeof mediaGroups !== 'object') return out;
  for (const groupType of Object.keys(mediaGroups)) {
    const group = mediaGroups[groupType];
    if (!group || typeof group !== 'object') continue;
    for (const groupName of Object.keys(group)) {
      const renditions = group[groupName];
      if (!renditions || typeof renditions !== 'object') continue;
      for (const renditionName of Object.keys(renditions)) {
        const r = renditions[renditionName];
        if (!r?.uri) continue;
        out.push({
          url: resolveUri(r.uri, baseUrl),
          type: groupType,
          name: renditionName,
          language: typeof r.language === 'string' ? r.language : null,
          default: !!r.default,
        });
      }
    }
  }
  return out;
}

export function parseManifest(text: string, baseUrl: string): ParsedHlsManifest {
  // Reject anything that isn't an HLS manifest up front. m3u8-parser silently
  // returns empty success on DASH/HTML/garbage input, which would mislabel
  // the entry as a media playlist with 0 segments.
  if (typeof text !== 'string' || !text.trim().startsWith('#EXTM3U')) {
    throw new Error('Not an HLS manifest (missing #EXTM3U)');
  }
  const parser = new Parser();
  parser.push(text);
  parser.end();
  const m = parser.manifest ?? {};
  const playlists = Array.isArray(m.playlists) ? m.playlists : [];
  const segments = Array.isArray(m.segments) ? m.segments : [];

  if (playlists.length > 0) {
    const variants: HlsVariant[] = playlists
      .map((pl) => {
        const attrs = pl.attributes ?? {};
        const res = attrs.RESOLUTION;
        return {
          url: resolveUri(pl.uri, baseUrl),
          bandwidth: typeof attrs.BANDWIDTH === 'number' ? attrs.BANDWIDTH : 0,
          resolution: res && res.width && res.height ? `${res.width}x${res.height}` : null,
          codecs: typeof attrs.CODECS === 'string' ? attrs.CODECS : null,
        };
      })
      .sort((a, b) => b.bandwidth - a.bandwidth);
    const alternates = collectAlternates(m.mediaGroups, baseUrl);
    // Master playlists don't carry per-variant durations — the popup
    // pulls duration from the matching variant entry (which is parsed
    // separately when its body is captured).
    return { isMaster: true, variants, alternates, segmentCount: 0, totalDuration: 0 };
  }

  // Sum #EXTINF for media playlists; popup uses this for the row's
  // duration label and the size estimate (bandwidth × duration).
  const totalDuration = segments.reduce((sum, seg) => sum + (seg.duration ?? 0), 0);
  return {
    isMaster: false,
    variants: [],
    alternates: [],
    segmentCount: segments.length,
    totalDuration,
  };
}
