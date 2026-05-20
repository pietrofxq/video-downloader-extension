import { MSG, parseExtensionMessage } from '../lib/messages.js';
import { log, redactUrl } from '../lib/log.js';
import { downloadHlsAsTs } from './downloader.js';
import { OpfsWorkspace } from './storage.js';
import type { DownloadOutcome, DownloadRequest } from '../lib/types.ts';

// On offscreen startup, sweep any workspaces left behind by a prior
// extension reload / crash mid-download. Cheap when the directory is
// empty; idempotent. Fire-and-forget so it doesn't block the first
// download request.
void OpfsWorkspace.cleanupAllStale().catch((err) =>
  log.warn('[offscreen] OPFS stale cleanup failed', err),
);

// The offscreen document is the long-lived host for download work:
// - SW spawns it the first time a download is requested.
// - SW posts RUN_DOWNLOAD via chrome.runtime.sendMessage.
// - We orchestrate manifest + key + segment fetches via PROXY_FETCH (routed
//   through the SW into a content script that runs in the player's iframe).
// - When done, we reply DOWNLOAD_DONE with a Blob URL. SW hands it to
//   chrome.downloads.download.

// One AbortController per in-flight download, keyed by requestId. The
// SW forwards CANCEL_DOWNLOAD here, we abort the matching controller,
// and downloadHlsAsTs (which has the signal) throws at its next
// throwIfAborted check.
const abortControllers = new Map<string, AbortController>();

// Per-blob-URL cleanup hooks. The downloader's output File lives in OPFS,
// so the workspace must stay alive until the SW signals REVOKE_BLOB
// (chrome.downloads has finished reading from the Blob URL). Keyed by
// the blob URL we hand to the SW.
const blobCleanups = new Map<string, () => Promise<void>>();

chrome.runtime.onMessage.addListener(
  (rawMsg: unknown, _sender, sendResponse: (response: unknown) => void) => {
    const msg = parseExtensionMessage(rawMsg);
    if (!msg) return false;

    if (msg.type === MSG.REVOKE_BLOB) {
      const url = msg.payload?.blobUrl;
      if (typeof url === 'string') {
        try {
          URL.revokeObjectURL(url);
        } catch {
          // ignore
        }
        const cleanup = blobCleanups.get(url);
        if (cleanup) {
          blobCleanups.delete(url);
          cleanup().catch((err) => log.warn('[offscreen] workspace cleanup failed', err));
        }
      }
      sendResponse({ ok: true });
      return false;
    }

    if (msg.type === MSG.CANCEL_DOWNLOAD) {
      const requestId = msg.payload?.requestId;
      if (typeof requestId === 'string') {
        const ctrl = abortControllers.get(requestId);
        if (ctrl) ctrl.abort(new DOMException('canceled', 'AbortError'));
      }
      sendResponse({ ok: true });
      return false;
    }

    // RUN_DOWNLOAD is the SW→offscreen kickoff. The popup→SW message uses
    // START_DOWNLOAD; we deliberately don't listen for that here so the
    // chrome.runtime.sendMessage broadcast doesn't cross-fire.
    if (msg.type !== MSG.RUN_DOWNLOAD) return false;
    const req = msg.payload;
    if (!req || typeof req.variantUrl !== 'string') {
      sendResponse({ ok: false, error: 'missing variantUrl' });
      return false;
    }
    handleDownload(req).then(
      (outcome) => sendResponse({ ok: true, outcome }),
      (err: unknown) => sendResponse({ ok: false, error: errorString(err) }),
    );
    return true; // async sendResponse
  },
);

interface ProxyFetchReply {
  ok: boolean;
  status?: number;
  body?: string;
  error?: string;
}

async function handleDownload(req: DownloadRequest): Promise<DownloadOutcome> {
  const proxyFetch = (payload: object): Promise<ProxyFetchReply> =>
    chrome.runtime
      .sendMessage({ type: MSG.PROXY_FETCH, payload })
      .then((r) => r as ProxyFetchReply)
      .catch((err: unknown) => ({
        ok: false,
        error: errorString(err),
      }));

  const onProgress = (progress: { stage: string; current: number; total: number }): void => {
    chrome.runtime
      .sendMessage({
        type: MSG.DOWNLOAD_PROGRESS,
        payload: { requestId: req.requestId, ...progress },
      })
      .catch(() => {});
  };

  const ctrl = new AbortController();
  abortControllers.set(req.requestId, ctrl);

  try {
    const result = await downloadHlsAsTs({ proxyFetch, onProgress, signal: ctrl.signal }, req);
    // Register the workspace cleanup against the blob URL. REVOKE_BLOB
    // arrives once chrome.downloads has finished reading the file (or
    // immediately, if the SW suppressed the save because the user
    // canceled past the abort window).
    blobCleanups.set(result.outcome.blobUrl, result.cleanup);
    await chrome.runtime
      .sendMessage({
        type: MSG.DOWNLOAD_DONE,
        payload: result.outcome,
      })
      .catch(() => {});
    return result.outcome;
  } catch (err) {
    // AbortError → user-initiated cancel. We still emit DOWNLOAD_ERROR so
    // the SW gets to see SOMETHING terminal land for this requestId, but
    // we tag it with code='Canceled' so the SW can resolve to the
    // 'canceled' state rather than 'error'. The SW already transitioned
    // to 'canceled' synchronously on the popup click — this is just the
    // confirmation arriving after the in-flight task unwinds.
    const isAbort =
      err instanceof DOMException && (err.name === 'AbortError' || err.name === 'canceled');
    const code = isAbort ? 'Canceled' : err instanceof Error ? err.name : 'Error';
    const message = isAbort ? 'canceled by user' : err instanceof Error ? err.message : String(err);
    await chrome.runtime
      .sendMessage({
        type: MSG.DOWNLOAD_ERROR,
        payload: { requestId: req.requestId, code, message },
      })
      .catch(() => {});
    if (!isAbort) {
      log.warn('[offscreen] download failed', {
        requestId: req.requestId,
        code,
        message,
        variantUrl: redactUrl(req.variantUrl),
      });
    }
    throw err;
  } finally {
    abortControllers.delete(req.requestId);
  }
}

function errorString(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
