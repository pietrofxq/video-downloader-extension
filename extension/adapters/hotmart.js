function safeHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function pathOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

export default {
  id: 'hotmart',
  matches(pageUrl /* , mediaUrl */) {
    const host = safeHost(pageUrl);
    if (!host || !host.endsWith('hotmart.com')) return false;
    return pathOf(pageUrl).includes('/club/');
  },
  scrapePageMeta(document) {
    // v0.3 will flesh this out; for v0.1 we just return document.title so the
    // PING/skeleton flow doesn't crash if the adapter is invoked.
    return {
      title: document.title || '',
      lessonTitle: null,
      sectionTitle: null,
      filenameHint: null,
    };
  },
  observe(/* document, onUpdate */) {
    return () => {};
  },
  deriveFilename({ pageMeta }) {
    const section = pageMeta?.sectionTitle;
    const lesson = pageMeta?.lessonTitle;
    if (section && lesson) return `${section} - ${lesson}`;
    if (lesson) return lesson;
    return pageMeta?.title || 'hotmart-lesson';
  },
  transformHeaders(headers) {
    return headers;
  },
};
