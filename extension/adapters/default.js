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

function scrapeDefaultMeta(doc) {
  const og = (prop) =>
    doc.querySelector(`meta[property="${prop}"]`)?.getAttribute('content') ?? null;
  return {
    title: doc.title || '',
    ogTitle: og('og:title'),
    ogVideoTitle: og('og:video:title'),
    ogDescription: og('og:description'),
    ogSiteName: og('og:site_name'),
  };
}

export default {
  id: 'default',
  matches() {
    return true;
  },
  scrapePageMeta: scrapeDefaultMeta,
  observe(doc, onUpdate) {
    if (typeof MutationObserver === 'undefined') return () => {};
    // Observe document.head (stable across SPA replacements) rather than the
    // <title> element directly — React Helmet, Vue meta etc. swap the title
    // node entirely, which would detach an observer attached to the old node.
    const head = doc.head || doc.documentElement;
    if (!head) return () => {};
    let last = doc.title || '';
    const observer = new MutationObserver(() => {
      const t = doc.title || '';
      if (t === last) return;
      last = t;
      onUpdate(scrapeDefaultMeta(doc));
    });
    observer.observe(head, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
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
