import { MSG } from '../lib/messages.js';

// Runs at document_start in every http(s) frame, including iframes.
// v0.2 will add fetch + XHR hooks here; for v0.1 we only PING so the SW
// can confirm all frames are reachable.
try {
  chrome.runtime
    .sendMessage({
      type: MSG.PING,
      payload: { context: 'frame', href: location.href, top: window.top === window },
    })
    .catch(() => {});
} catch {
  // Some sandboxed frames will throw on chrome.runtime access — swallow.
}
