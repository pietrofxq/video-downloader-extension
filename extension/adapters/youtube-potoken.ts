// Proof-of-origin token acquisition for InnerTube calls (v0.12 Phase B).
//
// WHY THIS EXISTS
//
// googlevideo refuses media URLs that came from an unattested InnerTube
// call. v0.12 field work pinned the behavior down precisely:
//
//   inline WEB session, itag 18, n-transformed  -> HTTP 206, real MP4
//   InnerTube WEB_CREATOR, itag 18, n-transformed -> 403
//   InnerTube WEB_CREATOR, itag 701 (4K), n-transformed -> 403
//
// The gate therefore attaches to how the URL was ACQUIRED, not to
// googlevideo generally — nothing appended to a gated URL rescues it.
// The token has to be present on the `/youtubei/v1/player` request that
// mints the URLs, as `serviceIntegrityDimensions.poToken`.
//
// This matters for 4K specifically because there is no way around it by
// swapping clients: the only ungated client (WEB) returns zero adaptive
// URLs under SABR, and every client that does return them is gated.
//
// STATUS: seam only. `acquirePoToken` currently always resolves null,
// which reproduces exactly the pre-v0.12 behavior — the ladder runs
// unattested and its URLs stay gated. Nothing downstream branches on a
// token being present, so wiring this in cannot regress anything. The
// BotGuard implementation lands behind this interface.
//
// WHAT REMAINS (the hard part)
//
// A poToken is minted from a BotGuard attestation. The runtime that
// produces it (`window.trayride`) is already loaded on every watch page
// and was confirmed reachable in v0.12 probing — that is the reason to
// mint in-page rather than reimplement the VM. The remaining work:
//
//   1. Run the BotGuard challenge in the page's MAIN world. `trayride`
//      is a page global, so the isolated-world content script cannot
//      touch it; this needs a main-world injection plus a postMessage
//      bridge back. `content/main-world-hooks.ts` is the precedent for
//      that pattern and the natural host.
//   2. Exchange the attestation for an integrity token.
//   3. Mint the poToken bound to the right identifier. Binding matters:
//      a session-bound token uses visitorData, a content-bound one uses
//      the videoId. Sending a token bound to the wrong identifier is
//      rejected, so this must be verified against a real request rather
//      than assumed.
//   4. Cache per binding and refresh on expiry.
//
// Do NOT ship a partial version of this that guesses at the binding.
// The verification loop is cheap now: attach a token, re-run a 4K
// download, and check whether the URLs come back ungated.

import { log } from '../lib/log.js';

/** What the token is scoped to. See step 3 above — sending the wrong one is rejected. */
export type PoTokenBinding =
  | { kind: 'session'; visitorData: string }
  | { kind: 'content'; videoId: string };

export interface PoTokenRequest {
  binding: PoTokenBinding;
  /** Page document, for reaching the main world where BotGuard lives. */
  doc: Document;
}

/**
 * Obtain a proof-of-origin token for the given binding.
 *
 * Returns null whenever a token cannot be produced — not implemented
 * yet, BotGuard unavailable, challenge failed, network error. Callers
 * MUST treat null as "proceed unattested" rather than as a hard
 * failure: an unattested ladder still surfaces the format inventory and
 * still lets the inline WEB progressive path work, so degrading is
 * strictly better than refusing to discover anything.
 */
export async function acquirePoToken(_req: PoTokenRequest): Promise<string | null> {
  log.debug('youtube poToken: acquisition not implemented — proceeding unattested');
  return null;
}
