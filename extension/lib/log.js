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

export function redactUrl(input) {
  if (!input) return input;
  let url;
  try {
    url = new URL(input);
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
  return mutated ? url.toString() : input;
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

let cachedLevel = LEVELS.info;

async function refreshLevel() {
  try {
    const { logLevel } = await chrome.storage.local.get('logLevel');
    if (logLevel && LEVELS[logLevel] !== undefined) {
      cachedLevel = LEVELS[logLevel];
    }
  } catch {
    // chrome.storage unavailable in some contexts (e.g. tests) — keep default
  }
}

if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.logLevel) {
      const next = changes.logLevel.newValue;
      if (next && LEVELS[next] !== undefined) cachedLevel = LEVELS[next];
    }
  });
  refreshLevel();
}

const MAX_REDACT_DEPTH = 3;

function redactString(s) {
  if (typeof s !== 'string') return s;
  if (s.includes('://')) {
    // Best-effort: redact any URL-like substrings
    return s.replace(/https?:\/\/\S+/g, (m) => redactUrl(m));
  }
  return s;
}

function redactValue(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value !== 'object') return value;
  if (depth >= MAX_REDACT_DEPTH) return value;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  // Only walk plain objects — avoid traversing class instances (Error, Map, DOM nodes, etc.).
  if (Object.getPrototypeOf(value) === Object.prototype) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

function emit(level, ...args) {
  if (LEVELS[level] < cachedLevel) return;
  const redacted = args.map((a) => redactValue(a));
  // eslint-disable-next-line no-console
  console[level === 'debug' ? 'log' : level](...redacted);
}

export const log = {
  debug: (...a) => emit('debug', ...a),
  info: (...a) => emit('info', ...a),
  warn: (...a) => emit('warn', ...a),
  error: (...a) => emit('error', ...a),
};
