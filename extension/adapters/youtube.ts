import { sanitizeFilename } from '../lib/sanitize-filename.js';
import type { Adapter, PageMeta } from '../lib/types.ts';

// Match watch / shorts / embed under the canonical YouTube hosts, plus
// the youtu.be short-link form. We deliberately don't match the home
// page, channel pages, or playlist-only URLs — there's no single video
// to download from those.
function isYouTubePage(pageUrl: string): boolean {
  try {
    const u = new URL(pageUrl);
    const host = u.hostname;
    if (host === 'youtu.be') {
      // youtu.be/<videoId> — the path identifies the video.
      return u.pathname.length > 1;
    }
    if (host !== 'www.youtube.com' && host !== 'youtube.com' && host !== 'm.youtube.com') {
      return false;
    }
    const path = u.pathname;
    return (
      path === '/watch' ||
      path.startsWith('/shorts/') ||
      path.startsWith('/embed/') ||
      path.startsWith('/live/')
    );
  } catch {
    return false;
  }
}

// `<title>` on a watch page is "Video Title - YouTube" (or localized
// variant). og:title carries just the video title and is the preferred
// source; fall back to stripping the trailing " - YouTube" from the
// document title.
function stripYouTubeSuffix(title: string): string {
  return title.replace(/\s+-\s+YouTube\s*$/i, '').trim();
}

/**
 * Walk a JSON object literal starting at `text[start]` (which must be
 * `{`). Returns the JSON substring including the closing brace, or null
 * if the structure is malformed. Used to extract YouTube's inline JSON
 * blobs out of `<script>` bodies without involving Function() / eval.
 */
function extractJsonObject(text: string, start: number): string | null {
  if (text[start] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// Shape we care about from ytInitialPlayerResponse. Keep this narrow —
// YouTube rotates field names occasionally, and the strict shape limits
// the blast radius when something moves. Untouched fields can stay
// untyped (`unknown`).
export interface YtPlayerResponse {
  videoDetails?: {
    videoId?: string;
    title?: string;
    author?: string;
    lengthSeconds?: string;
  };
  microformat?: {
    playerMicroformatRenderer?: {
      ownerChannelName?: string;
    };
  };
}

/**
 * Extract ytInitialPlayerResponse from a single inline-script body.
 * YouTube embeds the blob as either `var ytInitialPlayerResponse = {...};`
 * or `window["ytInitialPlayerResponse"] = {...};`. Returns null when the
 * needle isn't in this body — caller iterates scripts until one matches.
 *
 * Exported so unit tests can verify the extraction against captured
 * script text without spinning up a DOM.
 */
export function parseYtPlayerResponseFromScript(scriptText: string): YtPlayerResponse | null {
  const needle = scriptText.indexOf('ytInitialPlayerResponse');
  if (needle < 0) return null;
  const braceAt = scriptText.indexOf('{', needle);
  if (braceAt < 0) return null;
  const json = extractJsonObject(scriptText, braceAt);
  if (!json) return null;
  try {
    return JSON.parse(json) as YtPlayerResponse;
  } catch {
    return null;
  }
}

/**
 * Walk inline `<script>` elements until one yields a parseable
 * ytInitialPlayerResponse. The content script runs in an isolated world
 * so `window.ytInitialPlayerResponse` from the page itself is not
 * visible — we scrape the script text instead. Returns null when the
 * blob is absent (embed pages without a player payload, network errors
 * mid-render, etc.); the adapter falls back to og:meta in that case.
 */
function parseYtPlayerResponse(doc: Document): YtPlayerResponse | null {
  const scripts = doc.querySelectorAll('script');
  for (const s of scripts) {
    const parsed = parseYtPlayerResponseFromScript(s.textContent ?? '');
    if (parsed) return parsed;
  }
  return null;
}

function scrapeYouTubeMeta(doc: Document): PageMeta {
  const og = (prop: string): string | null =>
    doc.querySelector(`meta[property="${prop}"]`)?.getAttribute('content') ?? null;
  const ogTitle = og('og:title');
  const docTitle = doc.title ? stripYouTubeSuffix(doc.title) : '';

  // Prefer the player JSON when present — it carries the canonical
  // title, the channel/owner name, and the videoId without the
  // ambiguity of localized title suffixes.
  const player = parseYtPlayerResponse(doc);
  const videoDetails = player?.videoDetails ?? {};
  const microformat = player?.microformat?.playerMicroformatRenderer ?? {};

  const title = videoDetails.title || ogTitle || docTitle || '';
  const channelTitle = videoDetails.author || microformat.ownerChannelName || '';
  const videoId = videoDetails.videoId || '';

  return {
    title,
    ogTitle,
    ogVideoTitle: og('og:video:title'),
    ogDescription: og('og:description'),
    ogSiteName: og('og:site_name') ?? 'YouTube',
    ...(channelTitle ? { channelTitle } : {}),
    ...(videoId ? { videoId } : {}),
  };
}

const youtubeAdapter: Adapter = {
  id: 'youtube',
  matches(pageUrl) {
    return isYouTubePage(pageUrl);
  },
  scrapePageMeta: scrapeYouTubeMeta,
  observe(doc, onUpdate) {
    // YouTube is a single-page app: navigating watch → watch swaps the
    // <title> + meta tags but never reloads the document. The default
    // adapter's title-watcher pattern works here too.
    if (typeof MutationObserver === 'undefined') return () => {};
    const head = doc.head || doc.documentElement;
    if (!head) return () => {};
    let last = doc.title || '';
    const observer = new MutationObserver(() => {
      const t = doc.title || '';
      if (t === last) return;
      last = t;
      onUpdate(scrapeYouTubeMeta(doc));
    });
    observer.observe(head, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  },
  deriveFilename({ pageMeta }) {
    const title = pageMeta?.title || pageMeta?.ogTitle || '';
    const channel = pageMeta?.channelTitle || '';
    // Prefix with the channel so files from the same creator group
    // lexicographically in the user's downloads folder. Skip the prefix
    // when channel is missing rather than emitting a leading " - ".
    const raw = channel && title ? `${channel} - ${title}` : title;
    return sanitizeFilename(raw, { fallback: 'youtube-video' });
  },
};

export default youtubeAdapter;
