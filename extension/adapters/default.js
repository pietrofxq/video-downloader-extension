import { sanitizeFilename } from '../lib/sanitize-filename.js';

function basenameFromUrl(url) {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop() ?? '';
    return last.replace(/\.[a-z0-9]+$/i, '') || u.hostname;
  } catch {
    return 'video';
  }
}

export default {
  id: 'default',
  matches() {
    return true;
  },
  scrapePageMeta(document) {
    const og = (prop) =>
      document.querySelector(`meta[property="${prop}"]`)?.getAttribute('content') ?? null;
    return {
      title: document.title || '',
      ogTitle: og('og:title'),
      ogVideoTitle: og('og:video:title'),
      ogDescription: og('og:description'),
      ogSiteName: og('og:site_name'),
    };
  },
  observe() {
    return () => {};
  },
  deriveFilename({ pageMeta, url }) {
    const title = pageMeta?.title || pageMeta?.ogTitle || '';
    const basename = basenameFromUrl(url);
    const raw = title ? `${title} - ${basename}` : basename;
    return sanitizeFilename(raw, { fallback: basename || 'video' });
  },
  transformHeaders(headers) {
    return headers;
  },
};
