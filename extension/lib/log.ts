const REDACTED_PARAMS = new Set([
  'hdntl',
  'hdnts',
  'token',
  'signature',
  'sig',
  'policy',
  'key-pair-id',
  'x-amz-signature',
  'x-amz-security-token',
  'auth',
  'auth_token',
  'authorization',
  'bearer',
  'jwt',
  'jwttoken',
  'exp',
  'expires',
  'nonce',
]);

const REDACTION_PLACEHOLDER = '__REDACTED__';

export function redactUrl<T extends string | undefined | null>(input: T): T {
  if (!input) return input;
  let url: URL;
  try {
    url = new URL(input as string);
  } catch {
    return input;
  }
  const params = url.searchParams;
  let mutated = false;
  for (const key of [...params.keys()]) {
    if (REDACTED_PARAMS.has(key.toLowerCase())) {
      params.set(key, REDACTION_PLACEHOLDER);
      mutated = true;
    }
  }
  return (mutated ? url.toString() : input) as T;
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let cachedLevel: number = LEVELS.info;

async function refreshLevel(): Promise<void> {
  try {
    const { logLevel } = await chrome.storage.local.get('logLevel');
    if (typeof logLevel === 'string' && logLevel in LEVELS) {
      cachedLevel = LEVELS[logLevel as LogLevel];
    }
  } catch {
    // chrome.storage unavailable in some contexts (e.g. tests) — keep default
  }
}

if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.logLevel) {
      const next = changes.logLevel.newValue;
      if (typeof next === 'string' && next in LEVELS) cachedLevel = LEVELS[next as LogLevel];
    }
  });
  refreshLevel();
}

const MAX_REDACT_DEPTH = 3;

function redactString(s: unknown): unknown {
  if (typeof s !== 'string') return s;
  if (s.includes('://')) {
    return s.replace(/https?:\/\/\S+/g, (m) => redactUrl(m) ?? m);
  }
  return s;
}

function redactValue(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value !== 'object') return value;
  if (depth >= MAX_REDACT_DEPTH) return value;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  // Only walk plain objects — avoid traversing class instances (Error, Map, DOM nodes, etc.).
  if (Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

function emit(level: LogLevel, ...args: unknown[]): void {
  if (LEVELS[level] < cachedLevel) return;
  const redacted = args.map((a) => redactValue(a));
  const sink = level === 'debug' ? 'log' : level;
  // eslint-disable-next-line no-console
  (console[sink] as (...a: unknown[]) => void)(...redacted);
}

export const log = {
  debug: (...a: unknown[]) => emit('debug', ...a),
  info: (...a: unknown[]) => emit('info', ...a),
  warn: (...a: unknown[]) => emit('warn', ...a),
  error: (...a: unknown[]) => emit('error', ...a),
};
