// Pure helpers extracted from popup.ts so unit tests can exercise the
// quality picker / variant URL routing logic without spinning up a DOM
// or chrome.* mocks. The popup module itself has top-level side
// effects (chrome.runtime.connect, document queries) that would fire
// on import.
//
// Anything that's a pure transform from (MediaEntry + DownloadState +
// user input) → output belongs here. DOM rendering, message dispatch,
// and side-effecting wiring stay in popup.ts.

import { classifyUrl } from '../lib/media-detection.js';
import type { DownloadState, HlsVariant, MediaEntry } from '../lib/types.ts';

/**
 * True iff this variant can ride the project's stream-copy muxer.
 * Progressive + HLS variants always pass. DASH (YouTube adaptive)
 * variants need (a) a paired audio stream and (b) an AVC codec —
 * VP9-in-webm and AV1-in-cmaf can't be re-wrapped into mp4 without
 * re-encoding, which the project rules out.
 *
 * The popup uses this to FILTER VP9 / AV1 / video-only variants OUT
 * of the quality dropdown entirely (v0.11.3 follow-up — earlier
 * iterations labeled them "— not supported" but that made the first
 * option in the picker sometimes unselectable noise).
 */
export function isVariantDownloadable(v: HlsVariant): boolean {
  const kind = classifyUrl(v.url);
  if (kind !== 'dash') return true;
  if (!v.pairedAudioUrl) return false;
  // codecs is RFC 6381 (e.g. `avc1.640028`, `vp09.00.50.08`,
  // `av01.0.05M.08`). Empty / null is treated as unknown — assume
  // muxable rather than hide the variant entirely.
  const codecs = v.codecs ?? '';
  if (!codecs) return true;
  return /^avc1\./i.test(codecs);
}

/**
 * URL the row's badges (size / duration) should describe. Three cases:
 *
 *  1. A download is already running for this entry — use the
 *     `variantUrl` the SW recorded at click time. Pinning to this
 *     means the size badge doesn't visibly "revert" from the user's
 *     pick to variants[0] (highest bandwidth) when the dropdown is
 *     replaced by the in-progress UI. That false-positive was the
 *     v0.11.3 quality-picker regression report.
 *  2. Entry is a media playlist (single bitrate) — `entry.url` IS
 *     the playable URL.
 *  3. Master playlist with parsed variants — first variant (highest
 *     bandwidth after the parser sort) as a sensible default; the
 *     change handler in popup.ts patches the badge live as the user
 *     picks different qualities.
 *
 * Falls back to `entry.url` when none of the above apply (manifest
 * not parsed yet — the row's Download button stays disabled until
 * variants land).
 */
export function pickDisplayVariantUrl(
  entry: MediaEntry,
  downloadState: DownloadState | null | undefined,
): string {
  if (downloadState?.variantUrl) return downloadState.variantUrl;
  if (entry.isMaster === false) return entry.url;
  return entry.variants?.[0]?.url ?? entry.url;
}

/**
 * Click-time resolution of which URL the SW should download. Returns
 * null when the row isn't ready (a master playlist whose variants
 * haven't been parsed yet — the Download button is disabled in that
 * case, but defending against the race here is cheap insurance).
 */
export function pickDownloadVariantUrl(
  entry: MediaEntry,
  chosenSelectValue: string | undefined,
): string | null {
  if (typeof chosenSelectValue === 'string' && /^https?:/.test(chosenSelectValue)) {
    return chosenSelectValue;
  }
  // For a single-bitrate (media playlist) entry, the entry's own URL
  // is the playable one — no quality picker exists in that case.
  if (entry.isMaster === false) return entry.url;
  return null;
}

/** Format a HlsVariant for display in the quality picker dropdown. */
export function formatVariant(v: HlsVariant): string {
  const resPart = v.resolution?.includes('x')
    ? `${v.resolution.split('x')[1]}p`
    : v.resolution || '';
  const bwPart = v.bandwidth ? `${Math.round(v.bandwidth / 1000)} kbps` : '';
  if (resPart && bwPart) return `${resPart} (${bwPart})`;
  return resPart || bwPart || 'variant';
}

/**
 * Reduce an entry's variant list to what the dropdown should show.
 * Filters out anything unmuxable (VP9 / AV1 / adaptive-without-audio).
 *
 * Returned in the order they should appear; the popup's renderer
 * preserves that order verbatim.
 */
export function filterDownloadableVariants(variants: readonly HlsVariant[]): HlsVariant[] {
  return variants.filter(isVariantDownloadable);
}
