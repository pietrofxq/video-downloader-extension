// Cross-context message protocol. The `MSG` constants stay runtime
// values (the switch statements in every context use them as cases);
// the discriminated union below names each payload shape so a handler
// that switches on `msg.type` narrows to the right payload without
// any `as`-casts.
//
// Adding a new message:
//   1. Append to MSG below.
//   2. Add a corresponding interface (named <Verb>Message) extending
//      `MessageBase<typeof MSG.NAME>` with its payload field.
//   3. Add the new interface to ExtensionMessage's union.

import type {
  DiscoveredStream,
  DownloadOutcome,
  DownloadRequest,
  DownloadState,
  MediaKind,
  PageMeta,
} from './types.ts';

export const MSG = Object.freeze({
  PING: 'PING',
  MEDIA_URL_DETECTED: 'MEDIA_URL_DETECTED',
  MANIFEST_BODY: 'MANIFEST_BODY',
  PAGE_META: 'PAGE_META',
  GET_TAB_STATE: 'GET_TAB_STATE',
  TAB_STATE_UPDATED: 'TAB_STATE_UPDATED',
  START_DOWNLOAD: 'START_DOWNLOAD',
  RUN_DOWNLOAD: 'RUN_DOWNLOAD',
  DOWNLOAD_PROGRESS: 'DOWNLOAD_PROGRESS',
  DOWNLOAD_DONE: 'DOWNLOAD_DONE',
  DOWNLOAD_ERROR: 'DOWNLOAD_ERROR',
  PROXY_FETCH: 'PROXY_FETCH',
  REVOKE_BLOB: 'REVOKE_BLOB',
  SHOW_IN_FOLDER: 'SHOW_IN_FOLDER',
  DISMISS_DOWNLOAD: 'DISMISS_DOWNLOAD',
  CANCEL_DOWNLOAD: 'CANCEL_DOWNLOAD',
  RESET_TAB: 'RESET_TAB',
  ENSURE_PARSED: 'ENSURE_PARSED',
  STREAMS_DISCOVERED: 'STREAMS_DISCOVERED',
} as const);

export type MessageType = (typeof MSG)[keyof typeof MSG];

interface MessageBase<T extends MessageType> {
  type: T;
  requestId?: string;
}

// ---------- discriminated payloads ----------

export interface PingMessage extends MessageBase<typeof MSG.PING> {
  payload?: { context?: string };
}

export interface MediaUrlDetectedMessage extends MessageBase<typeof MSG.MEDIA_URL_DETECTED> {
  payload: {
    url: string;
    /** Optional — SW falls back to classifyUrl if absent. */
    kind?: MediaKind;
    headers?: Record<string, string>;
    /** Subordinate source tag — 'fetch', 'xhr', 'page', etc. */
    source?: string;
  };
}

export interface ManifestBodyMessage extends MessageBase<typeof MSG.MANIFEST_BODY> {
  payload: { url: string; text: string };
}

export interface PageMetaMessage extends MessageBase<typeof MSG.PAGE_META> {
  payload: { adapterId: string; meta: PageMeta };
}

export interface GetTabStateMessage extends MessageBase<typeof MSG.GET_TAB_STATE> {
  payload?: { tabId?: number };
}

export interface TabStateUpdatedMessage extends MessageBase<typeof MSG.TAB_STATE_UPDATED> {
  payload: { tabId: number };
}

export interface StartDownloadMessage extends MessageBase<typeof MSG.START_DOWNLOAD> {
  payload: {
    mediaId: string;
    variantUrl?: string;
    /** User-supplied filename (no extension); the SW sanitizes it. */
    filename?: string;
    /**
     * Selected audio track id when the entry has multi-track audio
     * (YouTube dubs). Optional — when omitted, the SW uses the
     * variant's default paired audio. See `MediaEntry.audioTracks`.
     */
    audioTrackId?: string;
  };
}

export interface RunDownloadMessage extends MessageBase<typeof MSG.RUN_DOWNLOAD> {
  payload: DownloadRequest;
}

export interface DownloadProgressMessage extends MessageBase<typeof MSG.DOWNLOAD_PROGRESS> {
  payload: {
    requestId: string;
    stage: 'fetch' | 'decrypt' | 'remux';
    /** Phase-weighted units; current/total drives the unified 0-100% bar. */
    current: number;
    total: number;
    /** Raw segment counter within the current stage (label only). */
    segmentCurrent: number;
    segmentTotal: number;
  };
}

export interface DownloadDoneMessage extends MessageBase<typeof MSG.DOWNLOAD_DONE> {
  payload: DownloadOutcome;
}

export interface DownloadErrorMessage extends MessageBase<typeof MSG.DOWNLOAD_ERROR> {
  payload: { requestId: string; code: string; message: string };
}

export interface ProxyFetchMessage extends MessageBase<typeof MSG.PROXY_FETCH> {
  payload: {
    tabId?: number;
    frameId?: number;
    url: string;
    headers?: Record<string, string>;
    responseType: 'text' | 'arrayBuffer';
  };
}

export interface RevokeBlobMessage extends MessageBase<typeof MSG.REVOKE_BLOB> {
  payload: { blobUrl: string };
}

export interface ShowInFolderMessage extends MessageBase<typeof MSG.SHOW_IN_FOLDER> {
  payload: { downloadId: number };
}

// Popup → SW: drop the cached DownloadState for this mediaId so the row
// goes back to its Download-button + quality-picker state. Used by the
// "Download again" and "Try again" buttons.
export interface DismissDownloadMessage extends MessageBase<typeof MSG.DISMISS_DOWNLOAD> {
  payload: { mediaId: string };
}

// Popup → SW → offscreen: cancel an in-flight download. Keyed by
// requestId (which the popup has on its DownloadState). The SW marks
// the state 'canceled' synchronously and forwards to the offscreen,
// which aborts the AbortController gating that request's fetches.
export interface CancelDownloadMessage extends MessageBase<typeof MSG.CANCEL_DOWNLOAD> {
  payload: { requestId: string };
}

// Popup → SW: empty the detected-media list for this tab. Keeps the
// per-adapter PageMeta so freshly-detected entries land with proper
// titles. Used by the header "Reset" button when the user wants the
// popup to forget stale captures and start observing fresh.
export interface ResetTabMessage extends MessageBase<typeof MSG.RESET_TAB> {
  payload: { tabId: number };
}

// Popup → SW: re-drive manifest parsing for any HLS entry on this tab
// that's still unresolved (no variants, no parseError). The popup's
// "Loading…" watchdog fires this when an eager parse was cut off by an
// MV3 service-worker teardown and the dropdown is stuck. ensureParsed is
// idempotent + in-flight-guarded, so this is safe to send repeatedly.
export interface EnsureParsedMessage extends MessageBase<typeof MSG.ENSURE_PARSED> {
  payload: { tabId: number };
}

// Content script → SW: catalog of streams the adapter found in the
// page DOM/JSON. Used by sites whose media URLs aren't visible to
// webRequest (YouTube's ytInitialPlayerResponse.streamingData). The SW
// promotes each into a MediaEntry, picking the adapter from the
// sender's pageUrl just like MEDIA_URL_DETECTED.
export interface StreamsDiscoveredMessage extends MessageBase<typeof MSG.STREAMS_DISCOVERED> {
  payload: { adapterId: string; streams: DiscoveredStream[] };
}

export type ExtensionMessage =
  | PingMessage
  | MediaUrlDetectedMessage
  | ManifestBodyMessage
  | PageMetaMessage
  | GetTabStateMessage
  | TabStateUpdatedMessage
  | StartDownloadMessage
  | RunDownloadMessage
  | DownloadProgressMessage
  | DownloadDoneMessage
  | DownloadErrorMessage
  | ProxyFetchMessage
  | RevokeBlobMessage
  | ShowInFolderMessage
  | DismissDownloadMessage
  | CancelDownloadMessage
  | ResetTabMessage
  | EnsureParsedMessage
  | StreamsDiscoveredMessage;

// ---------- popup ↔ SW port wire ----------
//
// Distinct from the runtime.sendMessage protocol — the popup keeps a
// long-lived port for state pushes. The shapes are listed here so popup
// + SW agree on the wire format.

export type PortMessageFromPopup = { type: 'SUBSCRIBE'; tabId: number | null };

export type PortMessageFromSW =
  | { type: 'STATE'; state: { entries: Array<import('./types.ts').MediaEntry> } }
  | { type: 'DOWNLOAD_STATE'; state: DownloadState }
  | { type: 'DOWNLOAD_DISMISSED'; mediaId: string };

// ---------- helpers ----------

const MSG_TYPES: ReadonlySet<string> = new Set(Object.values(MSG));

// Validate that `raw` is an object with a `type` that matches one of the
// MSG.* constants, and return it narrowed to ExtensionMessage. Returns
// null otherwise. Receive sites (SW, offscreen, popup) call this instead
// of `as ExtensionMessage` casting, so the switch on `msg.type` then
// narrows each `case` to the matching payload statically. If a new
// message variant is added without extending ExtensionMessage, the
// receive-site switch fails to compile rather than silently dropping.
export function parseExtensionMessage(raw: unknown): ExtensionMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const type = (raw as { type?: unknown }).type;
  if (typeof type !== 'string' || !MSG_TYPES.has(type)) return null;
  // The shape of each `payload` is asserted at the case level by the
  // ExtensionMessage union; we don't deep-validate here because the SW
  // and offscreen + popup are all internal trusted senders. The gate
  // exists to lock the type, not to defend against malicious payloads.
  return raw as ExtensionMessage;
}

// Same idea for the popup ↔ SW port wire.
const PORT_FROM_SW_TYPES: ReadonlySet<string> = new Set([
  'STATE',
  'DOWNLOAD_STATE',
  'DOWNLOAD_DISMISSED',
]);
export function parsePortMessageFromSW(raw: unknown): PortMessageFromSW | null {
  if (!raw || typeof raw !== 'object') return null;
  const type = (raw as { type?: unknown }).type;
  if (typeof type !== 'string' || !PORT_FROM_SW_TYPES.has(type)) return null;
  return raw as PortMessageFromSW;
}

// Compile-time exhaustiveness helper: drop in the `default:` branch of
// a switch to make sure every variant of ExtensionMessage is handled.
// Calling `assertNever(msg)` with anything other than `never` is a
// TypeError at compile time.
export function assertNever(_x: never): never {
  throw new Error('unreachable');
}

export function envelope<T extends MessageType>(
  type: T,
  payload: object = {},
  requestId?: string,
): { type: T; payload: object; requestId?: string } {
  const msg: { type: T; payload: object; requestId?: string } = { type, payload };
  if (requestId !== undefined) msg.requestId = requestId;
  return msg;
}
