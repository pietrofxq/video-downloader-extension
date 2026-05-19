import { MSG } from '../lib/messages.js';

// Runs at document_start in every http(s) frame, including iframes.
// Guard against non-http(s) frames (data:, blob:, javascript:) that can still
// match content-script patterns in edge cases.
if (/^https?:$/.test(location.protocol)) {
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
}
