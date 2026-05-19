import { Parser } from 'm3u8-parser';

function resolveUri(uri, baseUrl) {
  try {
    return new URL(uri ?? '', baseUrl).toString();
  } catch {
    return uri ?? '';
  }
}

/**
 * Pull non-variant rendition URIs out of mediaGroups (#EXT-X-MEDIA).
 * Hotmart and most HLS sources list subtitle / alternate-audio playlists
 * here; the player fetches them, webRequest sees them, and without this
 * extraction they'd show as separate top-level entries in the popup.
 */
function collectAlternates(mediaGroups, baseUrl) {
  const out = [];
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

/**
 * Parse an HLS m3u8 manifest body.
 *
 * @param {string} text     - raw manifest body
 * @param {string} baseUrl  - URL the manifest was fetched from
 * @returns {{
 *   isMaster: boolean,
 *   variants: { url: string, bandwidth: number, resolution: string|null, codecs: string|null }[],
 *   alternates: { url: string, type: string, name: string, language: string|null, default: boolean }[],
 *   segmentCount: number,
 * }}
 */
export function parseManifest(text, baseUrl) {
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
    const variants = playlists
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
    return { isMaster: true, variants, alternates, segmentCount: 0 };
  }

  return { isMaster: false, variants: [], alternates: [], segmentCount: segments.length };
}
