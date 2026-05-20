import type { MediaKind } from './types.ts';

export const KINDS = Object.freeze({
  HLS: 'hls',
  DASH: 'dash',
  PROGRESSIVE: 'progressive',
  SEGMENT: 'segment',
  KEY: 'key',
} as const);

export type DetectionKind = (typeof KINDS)[keyof typeof KINDS];

export const PRIMARY_KINDS: Set<DetectionKind> = new Set([
  KINDS.HLS,
  KINDS.DASH,
  KINDS.PROGRESSIVE,
]);

// webRequest match patterns. Broad-and-filter: the listener calls
// classifyUrl() to reject false positives like `metakeys.json` or paths
// containing `.mp4` mid-segment.
export const WEBREQUEST_PATTERNS = Object.freeze([
  '*://*/*.m3u8*',
  '*://*/*.mpd*',
  '*://*/*.mp4*',
  '*://*/*.webm*',
  '*://*/*.ts*',
  '*://*/*.m4s*',
  '*://*/*.key*',
  // YouTube streams. Path is /videoplayback?... with no file extension,
  // so the EXT_KIND map can't classify these; classifyUrl special-cases
  // googlevideo.com via the mime + itag query params. The YouTube
  // adapter's `discoverStreams` is the canonical catalog source — these
  // passive captures are a fallback signal.
  '*://*.googlevideo.com/videoplayback*',
]);

const EXT_KIND = new Map<string, DetectionKind>([
  ['.m3u8', KINDS.HLS],
  ['.mpd', KINDS.DASH],
  ['.mp4', KINDS.PROGRESSIVE],
  ['.webm', KINDS.PROGRESSIVE],
  ['.ts', KINDS.SEGMENT],
  ['.m4s', KINDS.SEGMENT],
  ['.key', KINDS.KEY],
]);

const CT_KIND: Array<[RegExp, DetectionKind]> = [
  [/mpegurl/i, KINDS.HLS],
  [/dash\+xml|application\/dash/i, KINDS.DASH],
  [/^video\/mp4/i, KINDS.PROGRESSIVE],
  [/^video\/webm/i, KINDS.PROGRESSIVE],
];

function getPathExtension(pathname: string): string {
  // Drop trailing slash, take last segment, lowercase the dot-suffix.
  const last = pathname.replace(/\/+$/, '').split('/').pop() ?? '';
  const dot = last.lastIndexOf('.');
  if (dot <= 0) return '';
  return last.slice(dot).toLowerCase();
}

// YouTube progressive (muxed audio+video, single-file MP4) itags.
// Everything else under `/videoplayback?...` is adaptive — video-only or
// audio-only fMP4 chunks that need pair-muxing into one MP4. The set is
// intentionally small + stable: 18 is the universal 360p/H.264+AAC
// fallback, 22 is 720p/H.264+AAC for older uploads, 36 is the legacy
// 3GP variant. New itag families are all adaptive.
const YOUTUBE_PROGRESSIVE_ITAGS: ReadonlySet<string> = new Set(['18', '22', '36']);

function classifyGoogleVideoUrl(u: URL): DetectionKind | null {
  // Apex `googlevideo.com` doesn't actually serve videoplayback — every
  // real host is a subdomain like `rr3---sn-xyz.googlevideo.com` — but
  // accept it defensively.
  if (u.hostname !== 'googlevideo.com' && !u.hostname.endsWith('.googlevideo.com')) {
    return null;
  }
  if (!u.pathname.startsWith('/videoplayback')) return null;
  const mime = u.searchParams.get('mime') || '';
  if (!mime.startsWith('video/') && !mime.startsWith('audio/')) return null;
  const itag = u.searchParams.get('itag') || '';
  if (YOUTUBE_PROGRESSIVE_ITAGS.has(itag)) return KINDS.PROGRESSIVE;
  // Adaptive fMP4 — closest existing kind is `dash` since the catalog
  // is conceptually the same (separate audio + video representations
  // muxed into one MP4). The lack of a `.mpd` manifest means the
  // YouTube adapter has to feed the catalog via `discoverStreams`.
  return KINDS.DASH;
}

export function classifyUrl(url: string, contentType?: string): DetectionKind | null {
  try {
    const u = new URL(url);
    const yt = classifyGoogleVideoUrl(u);
    if (yt !== null) return yt;
    const ext = getPathExtension(u.pathname);
    const byExt = EXT_KIND.get(ext);
    if (byExt) return byExt;
  } catch {
    // fall through to content-type
  }
  if (contentType) {
    for (const [re, kind] of CT_KIND) {
      if (re.test(contentType)) return kind;
    }
  }
  return null;
}

// Type predicate so callers can narrow DetectionKind → MediaKind without
// an `as` cast. PRIMARY_KINDS contains exactly the MediaKind values.
export function isPrimary(kind: DetectionKind | null): kind is MediaKind {
  return kind !== null && PRIMARY_KINDS.has(kind);
}
