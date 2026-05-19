import { log } from '../lib/log.js';
import { MSG } from '../lib/messages.js';
import { pickAdapter } from '../adapters/index.js';

log.info('SW alive');

chrome.runtime.onInstalled.addListener((details) => {
  log.info('SW installed:', details.reason);
});

// MV3 message handler contract: return `true` from this listener if you call
// sendResponse asynchronously, otherwise the channel closes and the sender's
// promise rejects. Synchronous handlers can return `false` (or nothing).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;
  switch (msg.type) {
    case MSG.PING: {
      const tabId = sender.tab?.id ?? null;
      const frame = sender.frameId ?? null;
      const pageUrl = sender.tab?.url ?? sender.url ?? '';
      const adapter = pickAdapter(pageUrl, '');
      log.info('PING from', { tabId, frame, pageUrl, adapter: adapter.id, context: msg.payload?.context });
      sendResponse({ ok: true, adapter: adapter.id });
      return false;
    }
    default:
      return false;
  }
});
