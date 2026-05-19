import { MSG } from '../lib/messages.js';
import { log, redactUrl } from '../lib/log.js';
import { downloadHlsAsTs } from './downloader.js';
import type { DownloadOutcome, DownloadRequest } from '../lib/types.ts';
import type { ExtensionMessage } from '../lib/messages.js';

// The offscreen document is the long-lived host for download work:
// - SW spawns it the first time a download is requested.
// - SW posts RUN_DOWNLOAD via chrome.runtime.sendMessage.
// - We orchestrate manifest + key + segment fetches via PROXY_FETCH (routed
//   through the SW into a content script that runs in the player's iframe).
// - When done, we reply DOWNLOAD_DONE with a Blob URL. SW hands it to
//   chrome.downloads.download.

chrome.runtime.onMessage.addListener(
  (rawMsg: unknown, _sender, sendResponse: (response: unknown) => void) => {
    if (!rawMsg || typeof rawMsg !== 'object') return false;
    const msg = rawMsg as ExtensionMessage;

    if (msg.type === MSG.REVOKE_BLOB) {
      const url = msg.payload?.blobUrl;
      if (typeof url === 'string') {
        try {
          URL.revokeObjectURL(url);
        } catch {
          // ignore
        }
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

  try {
    const outcome = await downloadHlsAsTs({ proxyFetch, onProgress }, req);
    await chrome.runtime
      .sendMessage({
        type: MSG.DOWNLOAD_DONE,
        payload: outcome,
      })
      .catch(() => {});
    return outcome;
  } catch (err) {
    const code = err instanceof Error ? err.name : 'Error';
    const message = err instanceof Error ? err.message : String(err);
    await chrome.runtime
      .sendMessage({
        type: MSG.DOWNLOAD_ERROR,
        payload: { requestId: req.requestId, code, message },
      })
      .catch(() => {});
    log.warn('[offscreen] download failed', {
      requestId: req.requestId,
      code,
      message,
      variantUrl: redactUrl(req.variantUrl),
    });
    throw err;
  }
}

function errorString(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
