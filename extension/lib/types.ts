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

export type DownloadStatus = 'pending' | 'progress' | 'saved' | 'error';
export type DownloadStage = 'fetch' | 'decrypt' | 'remux' | null;

export interface DownloadState {
  requestId: string;
  mediaId: string;
  tabId: number;
  filename: string;
  status: DownloadStatus;
  stage: DownloadStage;
  current: number;
  total: number;
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
  /** Returns a sanitized filename (no extension). Always produces a non-empty string. */
  deriveFilename(params: AdapterFilenameInput): string;
  /** Optional. Patch outbound headers before segment fetches. */
  transformHeaders?(headers?: Record<string, string>): Record<string, string> | undefined;
}
