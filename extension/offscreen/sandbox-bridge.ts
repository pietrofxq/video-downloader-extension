// Offscreen-side bridge to the sandboxed iframe declared in
// offscreen.html. The sandbox page runs under a CSP that allows
// `new Function(...)` (the offscreen document itself doesn't) — see
// extension/offscreen/sandbox.ts for the protocol.

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

let nextId = 1;
const pending = new Map<number, PendingCall>();
let readyPromise: Promise<Window> | null = null;
let listenerInstalled = false;

let sandboxReadyResolver: (() => void) | null = null;
const sandboxReadyPromise = new Promise<void>((resolve) => {
  sandboxReadyResolver = resolve;
});

function installResponseListener(): void {
  if (listenerInstalled) return;
  listenerInstalled = true;
  window.addEventListener('message', (event) => {
    const data = event.data as
      | {
          id?: unknown;
          ok?: unknown;
          result?: unknown;
          error?: unknown;
          type?: unknown;
        }
      | undefined;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'sandbox-ready') {
      sandboxReadyResolver?.();
      sandboxReadyResolver = null;
      return;
    }
    if (typeof data.id !== 'number') return;
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    if (data.ok === true) {
      entry.resolve(data.result);
    } else {
      entry.reject(new Error(typeof data.error === 'string' ? data.error : 'sandbox eval failed'));
    }
  });
}

/**
 * Resolve to the sandbox iframe's `contentWindow`. The iframe is
 * declared in offscreen.html and starts loading at page load; the
 * promise gates on its `load` event, then memoizes the result.
 *
 * Returns the sandbox Window — callers postMessage into it directly.
 */
export function ensureSandbox(): Promise<Window> {
  if (readyPromise) return readyPromise;
  installResponseListener();
  readyPromise = (async (): Promise<Window> => {
    const iframe = document.getElementById('vdl-sandbox') as HTMLIFrameElement | null;
    if (!iframe) {
      throw new Error('sandbox iframe (#vdl-sandbox) not found in offscreen.html');
    }
    // Race the sandbox's "ready" announcement against a ping-and-wait.
    // The sandbox posts 'sandbox-ready' as the last step of its script;
    // if it loaded before our listener was installed, that message was
    // missed, so we proactively ping it. The sandbox replies to 'ping'
    // by re-announcing.
    const ping = (): void => {
      try {
        iframe.contentWindow?.postMessage({ type: 'ping' }, '*');
      } catch {
        // ignore — pre-load contentWindow may not exist yet
      }
    };
    // First ping immediately, then a couple of retries to cover the
    // load-in-flight case.
    ping();
    const retryTimer = setInterval(ping, 200);
    try {
      await Promise.race([
        sandboxReadyPromise,
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error('sandbox did not announce ready within 5s')), 5000),
        ),
      ]);
    } finally {
      clearInterval(retryTimer);
    }
    const win = iframe.contentWindow;
    if (!win) throw new Error('sandbox iframe has no contentWindow after ready');
    return win;
  })();
  // On failure, drop the cached promise so a subsequent call retries.
  readyPromise.catch(() => {
    readyPromise = null;
  });
  return readyPromise;
}

/**
 * Evaluate a JS script inside the sandbox via `new Function(script)()`.
 * The script's body is run inside a function — its `return` statement
 * (if any) becomes the resolved value of this promise.
 */
export async function evalInSandbox(script: string): Promise<unknown> {
  const sandbox = await ensureSandbox();
  const id = nextId++;
  return new Promise<unknown>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      sandbox.postMessage({ id, script }, '*');
    } catch (err) {
      pending.delete(id);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
