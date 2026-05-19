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

export function classifyUrl(url: string, contentType?: string): DetectionKind | null {
  try {
    const u = new URL(url);
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

export function isPrimary(kind: DetectionKind | null): boolean {
  return kind !== null && PRIMARY_KINDS.has(kind);
}
