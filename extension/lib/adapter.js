// Formal Adapter contract (JSDoc-only — no runtime code). Imported as a type
// reference from adapters/*.js and consumers via `@type {import('../lib/adapter.js').Adapter}`.

/**
 * Metadata scraped from a page. Shape is intentionally loose — every field
 * is optional and each adapter can extend it with its own keys.
 *
 * @typedef {object} PageMeta
 * @property {string} [title]            Document title, the universal fallback.
 * @property {string} [lessonTitle]      Hotmart adapter: lesson h1 text.
 * @property {string} [sectionTitle]     Hotmart adapter: section line above the h1.
 * @property {string} [filenameHint]     A site-supplied filename, e.g. Hotmart's iframe `cur` param.
 * @property {string|null} [ogTitle]
 * @property {string|null} [ogVideoTitle]
 * @property {string|null} [ogDescription]
 * @property {string|null} [ogSiteName]
 */

/**
 * @typedef {'hls'|'dash'|'progressive'} MediaKind
 */

/**
 * @typedef {object} MediaEntry
 * @property {string} id                 UUID assigned by the store on insert.
 * @property {MediaKind} kind
 * @property {string} url
 * @property {string} pageUrl            The top-level tab URL, NOT the iframe URL.
 * @property {string} adapterId
 * @property {number} capturedAt
 * @property {Record<string,string>} [headers]
 * @property {PageMeta} [meta]
 */

/**
 * @typedef {object} Adapter
 * @property {string} id
 *   Kebab-case stable id. Used in messages, the popup adapter badge, and
 *   options-page per-adapter toggles. Must match the filename
 *   (`hotmart.js` → `'hotmart'`).
 *
 * @property {(pageUrl: string, mediaUrl: string) => boolean} matches
 *   Returns true if this adapter handles a detection on `pageUrl`. The
 *   `mediaUrl` is supplied for adapters that need to dispatch by stream URL
 *   shape, but most should match purely on `pageUrl`.
 *
 * @property {(document: Document) => PageMeta} scrapePageMeta
 *   Synchronous read from the top-frame DOM. Must NOT make network calls.
 *   Returns a (possibly empty) PageMeta. Falsy fields are fine — downstream
 *   consumers handle them defensively.
 *
 * @property {(document: Document, onUpdate: (meta: PageMeta) => void) => () => void} [observe]
 *   Optional. Set up SPA-navigation tracking (typically MutationObserver)
 *   and call `onUpdate(newMeta)` when the page meta meaningfully changes.
 *   Must return a cleanup function. If unimplemented, the SW only sees the
 *   initial scrape from `scrapePageMeta`.
 *
 * @property {(params: { pageMeta?: PageMeta, url: string, mediaEntry?: MediaEntry }) => string} deriveFilename
 *   Returns a sanitized filename (no extension). Must always produce a
 *   non-empty string — fall back to a stable literal if every input is
 *   missing (default adapter falls back to the URL basename;
 *   Hotmart falls back to `'hotmart-lesson'`).
 *
 * @property {(headers?: Record<string,string>) => Record<string,string>|undefined} [transformHeaders]
 *   Optional. Patch outbound headers before segment fetches in v0.6+.
 *   Most adapters return the input unchanged.
 */

export {};
