// MV3 sandbox page — runs under a CSP that allows `new Function()`,
// which the offscreen document forbids by default. The only purpose is
// to evaluate the YouTube n/sig decipher script that yt-sig.ts extracts
// from base.js. Communication is strictly via window.postMessage.
//
// Protocol:
//   Parent → sandbox:  { id: number, script: string }
//   Sandbox → parent:  { id: number, ok: true, result: unknown }
//                  or  { id: number, ok: false, error: string }
//
// We don't validate origins — the only frame that can postMessage in is
// the offscreen document (the iframe is loaded from chrome-extension://
// at a known path) and there's no UI to be tricked into navigating
// elsewhere. The sandbox has no chrome.* access, so even if it ran
// hostile code it can't reach the rest of the extension.

interface RunMessage {
  id?: unknown;
  script?: unknown;
}

// Announce ready immediately so the bridge can resolve its
// `ensureSandbox()` promise without depending on the iframe load
// event firing within the listener-installation window. The bridge
// also accepts an explicit ping message ({ type: 'ping' }) to handle
// the case where we loaded BEFORE it installed its listener.
function announceReady(): void {
  try {
    parent.postMessage({ type: 'sandbox-ready' }, '*');
  } catch {
    // Top-level only — ignored.
  }
}

window.addEventListener('message', (event: MessageEvent<RunMessage & { type?: unknown }>) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  if ((data as { type?: unknown }).type === 'ping') {
    announceReady();
    return;
  }
  const id = data.id;
  const script = data.script;
  if (typeof id !== 'number') return;
  if (typeof script !== 'string') {
    event.source?.postMessage(
      { id, ok: false, error: 'sandbox: script must be a string' },
      // postMessage to MessageEventSource requires either an origin or
      // a transferable list; '*' is fine because the sandbox doesn't
      // accept callers other than its parent (the same origin frame
      // would be the only one that could postMessage in too).
      { targetOrigin: '*' },
    );
    return;
  }

  let result: unknown;
  let error: string | undefined;
  try {
    // The script ends with `return ...;` (yt-sig builds it that way).
    // new Function() wraps the body in a function definition, so the
    // return statement is valid.
    const fn = new Function(script);
    result = fn();
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const payload =
    error !== undefined ? { id, ok: false as const, error } : { id, ok: true as const, result };
  event.source?.postMessage(payload, { targetOrigin: '*' });
});

// Fire the initial announcement after the listener is installed.
announceReady();
