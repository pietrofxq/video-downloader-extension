import { sanitizeFilename } from '../lib/sanitize-filename.js';
import type { Adapter, PageMeta } from '../lib/types.ts';

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

function textOf(el: Element | null | undefined): string {
  return el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

// Walk backward from the h1 until we find an element with non-empty text.
// Hotmart's section line is typically the immediately-prior block-level
// element (a span, p, or div) above the lesson h1.
function findSectionSibling(h1: Element | null): string {
  let candidate = h1?.previousElementSibling ?? null;
  let hops = 0;
  while (candidate && hops < 6) {
    const t = textOf(candidate);
    if (t) return t;
    candidate = candidate.previousElementSibling;
    hops += 1;
  }
  return '';
}

function findEmbedIframe(document: Document): HTMLIFrameElement | null {
  return (
    document.querySelector<HTMLIFrameElement>('iframe[src*="cf-embed.play.hotmart.com"]') ||
    document.querySelector<HTMLIFrameElement>('iframe[src*="play.hotmart.com/embed"]') ||
    document.querySelector<HTMLIFrameElement>('iframe#hotmart-player-embed')
  );
}

function scrapeHotmartMeta(doc: Document): PageMeta {
  const h1 = doc.querySelector('h1');
  const lessonTitle = textOf(h1);
  const sectionTitle = findSectionSibling(h1);

  let filenameHint = '';
  const iframe = findEmbedIframe(doc);
  if (iframe) {
    try {
      const u = new URL(iframe.getAttribute('src') || '', location.href);
      filenameHint = u.searchParams.get('cur') || '';
    } catch {
      // malformed src — leave hint empty
    }
  }

  return {
    title: doc.title || '',
    lessonTitle,
    sectionTitle,
    filenameHint,
  };
}

function metaKey(m: PageMeta): string {
  // JSON.stringify is unambiguous — `|` could collide if any field contained
  // it, suppressing a legitimate onUpdate.
  return JSON.stringify([m.title, m.lessonTitle, m.sectionTitle, m.filenameHint]);
}

const hotmartAdapter: Adapter = {
  id: 'hotmart',
  matches(pageUrl) {
    const host = safeHost(pageUrl);
    if (!host) return false;
    if (host !== 'hotmart.com' && !host.endsWith('.hotmart.com')) return false;
    return pathOf(pageUrl).includes('/club/');
  },
  scrapePageMeta: scrapeHotmartMeta,
  observe(doc, onUpdate) {
    // Prefer a scoped landmark so chat widgets / animations elsewhere on the
    // page don't dispatch records to our debounced tick. Falls back to body
    // if neither <main> nor [role="main"] exists.
    const root =
      doc.querySelector('main') ||
      doc.querySelector('[role="main"]') ||
      doc.body ||
      doc.documentElement;
    if (!root || typeof MutationObserver === 'undefined') return () => {};

    // Seed `last` from the current DOM so we don't fire an "update" on the
    // initial scrape — page-content.js already sent that one synchronously.
    let last = metaKey(scrapeHotmartMeta(doc));
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = (): void => {
      timer = null;
      try {
        const meta = scrapeHotmartMeta(doc);
        const key = metaKey(meta);
        if (key !== last) {
          last = key;
          onUpdate(meta);
        }
      } catch {
        // ignore scrape errors — DOM may be mid-transition
      }
    };

    const observer = new MutationObserver(() => {
      if (timer) return;
      timer = setTimeout(tick, 250);
    });
    // childList + subtree is sufficient: Hotmart's SPA re-renders nodes
    // rather than mutating text in place, so characterData would just be
    // extra work.
    observer.observe(root, { childList: true, subtree: true });

    return () => {
      if (timer) clearTimeout(timer);
      observer.disconnect();
    };
  },
  deriveFilename({ pageMeta }) {
    const section = pageMeta?.sectionTitle;
    const lesson = pageMeta?.lessonTitle;
    let raw: string | undefined;
    if (section && lesson) raw = `${section} - ${lesson}`;
    else if (lesson) raw = lesson;
    else if (pageMeta?.filenameHint) raw = pageMeta.filenameHint.replace(/\.[a-z0-9]+$/i, '');
    else raw = pageMeta?.title;
    return sanitizeFilename(raw, { fallback: 'hotmart-lesson' });
  },
  transformHeaders(headers) {
    return headers;
  },
};

export default hotmartAdapter;
