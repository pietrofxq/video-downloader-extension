import { MSG } from '../lib/messages.js';

// Top frame only — manifest restricts via all_frames default (false).
chrome.runtime
  .sendMessage({ type: MSG.PING, payload: { context: 'page', href: location.href } })
  .catch(() => {});
