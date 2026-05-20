// Shared domain types for the v0.9 TypeScript migration.
//
// Modules across the extension import from here so the contracts are
// authoritative in one place. Keep this file pure types (no runtime
// code) so it remains a `import type` candidate at conversion sites.

// ---------- media detection ----------

export type MediaKind = 'hls' | 'dash' | 'progressive';

export interface PageMeta {
  /** Document title — universal fallback. */
  title?: string;
  /** Hotmart adapter: lesson h1 text. */
  lessonTitle?: string;
  /** Hotmart adapter: section line above the lesson title. */
  sectionTitle?: string;
  /** Site-supplied filename hint (e.g. Hotmart's iframe `cur` param). */
  filenameHint?: string;
  /**
   * Publisher / uploader name. YouTube populates this from the channel;
   * other adapters with a clear "creator" concept can too. The downloader
   * uses it to prefix filenames so a user grabbing a series ends up with
   * files that group lexicographically.
   */
  channelTitle?: string;
  /** Platform-stable identifier for the video. YouTube videoId. */
  videoId?: string;
  ogTitle?: string | null;
  ogVideoTitle?: string | null;
  ogDescription?: string | null;
  ogSiteName?: string | null;
}

export interface MediaEntry {
  /** UUID assigned by the media store on insert. */
  id: string;
  kind: MediaKind;
  url: string;
  /** Top-level tab URL — NOT the iframe URL. */
  pageUrl: string;
  adapterId: string;
  capturedAt: number;
  /** Frame ID where the request originated; SW uses it to route PROXY_FETCH. */
  frameId?: number;
  headers?: Record<string, string>;
  meta?: PageMeta;
  /** True if the manifest's encryption can't be handled (set by adapters / DASH). */
  drm?: boolean;

  // Populated after manifest parsing for HLS entries:
  isMaster?: boolean;
  variants?: HlsVariant[];
  alternates?: HlsAlternate[];
  segmentCount?: number;
  /** Sum of `#EXTINF` durations for media playlists (seconds). */
  totalDuration?: number;
  /** Set if parsing the manifest failed; popup shows "manifest unavailable". */
  parseError?: string;
}

// ---------- HLS parsing ----------

export interface HlsVariant {
  url: string;
  bandwidth: number;
  /** "1920x1080" or null when not declared. */
  resolution: string | null;
  /** RFC 6381 codec list (`avc1.64...`, `mp4a.40.2`) or null. */
  codecs: string | null;
  /**
   * Exact byte length when the platform declares it (YouTube does via
   * `streamingData.formats[].contentLength`). HLS variants leave this
   * unset — the popup falls back to bandwidth × duration / 8.
   */
  contentLength?: number;
}

export interface HlsAlternate {
  url: string;
  /** "AUDIO" / "SUBTITLES" / "CLOSED-CAPTIONS" — the EXT-X-MEDIA TYPE. */
  type: string;
  /** GROUP-ID + the rendition NAME, e.g. "en-US". */
  name: string;
  language: string | null;
  default: boolean;
}

export interface ParsedHlsManifest {
  isMaster: boolean;
  variants: HlsVariant[];
  alternates: HlsAlternate[];
  segmentCount: number;
  /**
   * Sum of `#EXTINF` durations for media playlists (seconds). Zero on
   * masters — they don't carry per-variant durations; the matching
   * variant entry's totalDuration is the source for masters.
   */
  totalDuration: number;
}

// ---------- download pipeline ----------

export interface DownloadRequest {
  requestId: string;
  /** Chosen variant playlist URL (or media playlist for single-bitrate). */
  variantUrl: string;
  tabId: number;
  /** Frame ID to route proxy fetches to. */
  frameId: number;
  headers?: Record<string, string>;
  /** Sanitized base name (no extension); orchestrator appends `.mp4`. */
  filename: string;
}

export interface DownloadOutcome {
  requestId: string;
  /** `blob:` URL produced by the offscreen document. */
  blobUrl: string;
  /** Includes the `.mp4` extension. */
  filename: string;
  bytes: number;
  segments: number;
}

export type DownloadStatus = 'queued' | 'pending' | 'progress' | 'saved' | 'error' | 'canceled';
export type DownloadStage = 'fetch' | 'decrypt' | 'remux' | null;

export interface DownloadState {
  requestId: string;
  mediaId: string;
  tabId: number;
  filename: string;
  status: DownloadStatus;
  stage: DownloadStage;
  /**
   * Unified phase-weighted progress. `current/total` is the single 0-1
   * fraction the popup turns into the bar percentage; it advances
   * monotonically across fetch → decrypt → remux so the bar never
   * resets between stages.
   */
  current: number;
  total: number;
  /**
   * Raw per-stage segment counter for the "segment X/Y" label under the
   * progress bar. Distinct from current/total because those are now
   * weighted units, not segment counts.
   */
  segmentCurrent?: number;
  segmentTotal?: number;
  /** Set when status === 'saved'. */
  downloadId?: number;
  bytes?: number;
  /** Set when status === 'error'. The typed-error class name. */
  errorCode?: string;
  errorMessage?: string;
  startedAt: number;
  updatedAt?: number;
}

// ---------- adapter contract ----------

/**
 * Stable kebab-case id. Matches the filename minus extension
 * (`hotmart.ts` → `'hotmart'`). Used in messages, the popup adapter
 * badge, and options-page per-adapter toggles.
 */
export type AdapterId = string;

export interface AdapterFilenameInput {
  pageMeta?: PageMeta;
  url: string;
  mediaEntry?: MediaEntry;
}

/**
 * Catalog of media surfaced by an adapter that read it out of
 * page-loaded JSON rather than waiting for a webRequest to fire. Used
 * by sites whose media URLs aren't observable through the normal
 * detection layer — e.g. YouTube's `ytInitialPlayerResponse.streamingData`,
 * where the full catalog of available formats is in the page DOM and
 * webRequest only sees one chunk at a time of whichever quality the
 * player is currently fetching.
 *
 * One `DiscoveredStream` represents one *video* (not one quality). The
 * available qualities go in `variants[]` so the popup ends up with one
 * row + a quality picker, the same shape an HLS master playlist
 * produces. The SW promotes each into a MediaEntry, filling in the
 * fields the adapter can't know (id, capturedAt, pageUrl).
 */
export interface DiscoveredStream {
  /**
   * Identity URL — the value the SW writes into MediaEntry.url. Used
   * for dedupe. For sites with variants, an anchor (highest-quality
   * video URL, or a synthetic key) is fine.
   */
  url: string;
  kind: MediaKind;
  headers?: Record<string, string>;
  /** Seconds. Pre-filled when the platform publishes it. */
  totalDuration?: number;
  /** Marks the stream as DRM-gated. Same semantics as MediaEntry.drm. */
  drm?: boolean;
  /**
   * Per-quality formats. Shape matches HlsVariant so the popup quality
   * picker works uniformly across adapter-supplied + manifest-parsed
   * entries. Audio-only renditions are excluded here — the downloader
   * pairs a chosen video variant with a default audio variant
   * internally for the adaptive HD path.
   */
  variants?: HlsVariant[];
}

/**
 * Context passed to Adapter.transformUrl so the adapter can decide
 * whether the rewrite applies (some signing schemes only apply to
 * segment URLs, not manifest URLs).
 */
export interface TransformUrlContext {
  purpose: 'manifest' | 'segment' | 'key';
}

export interface Adapter {
  id: AdapterId;
  /** True iff this adapter handles a detection on `pageUrl`. */
  matches(pageUrl: string, mediaUrl: string): boolean;
  /** Synchronous read from the top-frame DOM. MUST NOT make network calls. */
  scrapePageMeta(document: Document): PageMeta;
  /**
   * Optional. Hook for SPA-navigation tracking (MutationObserver). Must
   * call `onUpdate(meta)` when the page meta meaningfully changes and
   * return a cleanup function. If unset, only the initial scrape is used.
   */
  observe?(document: Document, onUpdate: (meta: PageMeta) => void): () => void;
  /**
   * Optional. Read available media streams out of the page DOM/JSON.
   * Called from the content script after the initial scrape, and again
   * when `observe` fires (SPA navigation). Returning an empty list is
   * fine — passive webRequest detection still runs alongside.
   *
   * MUST NOT make network calls; same constraint as scrapePageMeta.
   */
  discoverStreams?(document: Document): DiscoveredStream[];
  /** Returns a sanitized filename (no extension). Always produces a non-empty string. */
  deriveFilename(params: AdapterFilenameInput): string;
  /** Optional. Patch outbound headers before segment fetches. */
  transformHeaders?(headers?: Record<string, string>): Record<string, string> | undefined;
  /**
   * Optional. Rewrite a URL before the downloader fetches it — e.g.
   * YouTube's `n` parameter has to be re-signed via an obfuscated JS
   * function pulled from `base.js` or the CDN throttles the response.
   * Returning the input unchanged is the no-op default. May be async
   * so the adapter can lazy-load and cache its signing material.
   */
  transformUrl?(url: string, ctx: TransformUrlContext): string | Promise<string>;
}
