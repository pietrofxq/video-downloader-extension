import { redactUrl } from './log.js';

/**
 * Fetch an HLS/DASH manifest with cookies + adapter-supplied headers.
 * Throws on non-2xx. Caller is responsible for typing the error
 * (v0.6 promotes 403s to TokenExpiredError etc.).
 *
 * @param {string} url
 * @param {Record<string,string>} [headers]
 * @returns {Promise<{ text: string, finalUrl: string }>}
 */
export async function fetchManifest(url, headers) {
  const res = await fetch(url, {
    credentials: 'include',
    headers: headers ?? {},
    redirect: 'follow',
  });
  if (!res.ok) {
    throw new Error(`manifest fetch ${res.status} for ${redactUrl(url)}`);
  }
  const text = await res.text();
  return { text, finalUrl: res.url || url };
}
