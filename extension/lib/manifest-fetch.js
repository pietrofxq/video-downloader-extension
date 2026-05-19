import { redactUrl } from './log.js';

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Fetch an HLS/DASH manifest with cookies + adapter-supplied headers.
 * Throws on non-2xx. Caller is responsible for typing the error
 * (v0.6 promotes 403s to TokenExpiredError etc.).
 *
 * A hard timeout (default 15s) prevents stalled fetches from leaking
 * inFlightParses keys in the SW.
 *
 * @param {string} url
 * @param {Record<string,string>} [headers]
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ text: string, finalUrl: string }>}
 */
export async function fetchManifest(url, headers, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      credentials: 'include',
      headers: headers ?? {},
      redirect: 'follow',
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new Error(`manifest fetch ${res.status} for ${redactUrl(url)}`);
    }
    const text = await res.text();
    return { text, finalUrl: res.url || url };
  } finally {
    clearTimeout(timer);
  }
}
