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

function scrapeYouTubeMeta(doc: Document): PageMeta {
  const og = (prop: string): string | null =>
    doc.querySelector(`meta[property="${prop}"]`)?.getAttribute('content') ?? null;
  const ogTitle = og('og:title');
  const docTitle = doc.title ? stripYouTubeSuffix(doc.title) : '';
  return {
    title: ogTitle || docTitle || '',
    ogTitle,
    ogVideoTitle: og('og:video:title'),
    ogDescription: og('og:description'),
    ogSiteName: og('og:site_name') ?? 'YouTube',
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
    // Subsequent commits will enrich this with channelTitle ("{channel}
    // - {video}") once discoverStreams + the catalog scrape lands. For
    // the stub, just the video title gets us a reasonable name.
    const raw = pageMeta?.title || pageMeta?.ogTitle || '';
    return sanitizeFilename(raw, { fallback: 'youtube-video' });
  },
};

export default youtubeAdapter;
