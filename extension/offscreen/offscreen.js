import { MSG } from '../lib/messages.js';
import { redactUrl } from '../lib/log.js';
import { downloadHlsAsTs } from './downloader.js';

// The offscreen document is the long-lived host for download work:
// - SW spawns it the first time a download is requested.
// - SW posts START_DOWNLOAD via chrome.runtime.sendMessage.
// - We orchestrate manifest + key + segment fetches via PROXY_FETCH (routed
//   through the SW into a content script that runs in the player's iframe).
// - When done, we reply DOWNLOAD_DONE with a Blob URL. SW hands it to
//   chrome.downloads.download.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;
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
    (err) => sendResponse({ ok: false, error: String(err?.message ?? err) }),
  );
  return true; // async sendResponse
});

async function handleDownload(req) {
  const proxyFetch = (payload) =>
    chrome.runtime.sendMessage({ type: MSG.PROXY_FETCH, payload }).catch((err) => ({
      ok: false,
      error: String(err?.message ?? err),
    }));

  const onProgress = (progress) => {
    chrome.runtime
      .sendMessage({
        type: MSG.DOWNLOAD_PROGRESS,
        payload: { requestId: req.requestId, ...progress },
      })
      .catch(() => {});
  };

  try {
    const outcome = await downloadHlsAsTs({ proxyFetch, onProgress }, req);
    // Notify SW so it can hand the blob URL to chrome.downloads.download.
    await chrome.runtime
      .sendMessage({
        type: MSG.DOWNLOAD_DONE,
        payload: outcome,
      })
      .catch(() => {});
    return outcome;
  } catch (err) {
    const code = err?.name ?? 'Error';
    const message = err?.message ?? String(err);
    await chrome.runtime
      .sendMessage({
        type: MSG.DOWNLOAD_ERROR,
        payload: { requestId: req.requestId, code, message },
      })
      .catch(() => {});
    // Surface the redacted-url variant in the offscreen console for dev visibility.
    // eslint-disable-next-line no-console
    console.warn('[offscreen] download failed', {
      requestId: req.requestId,
      code,
      message,
      variantUrl: redactUrl(req.variantUrl),
    });
    throw err;
  }
}
