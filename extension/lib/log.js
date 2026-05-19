const REDACTED_PARAMS = new Set([
  'hdntl',
  'token',
  'signature',
  'policy',
  'key-pair-id',
  'x-amz-signature',
  'x-amz-security-token',
  'auth',
  'authorization',
  'jwt',
  'jwttoken',
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

function emit(level, ...args) {
  if (LEVELS[level] < cachedLevel) return;
  const redacted = args.map((a) => (typeof a === 'string' ? redactString(a) : a));
  console[level === 'debug' ? 'log' : level](...redacted);
}

function redactString(s) {
  if (s.includes('://')) {
    // Best-effort: redact any URL-like substrings
    return s.replace(/https?:\/\/\S+/g, (m) => redactUrl(m));
  }
  return s;
}

export const log = {
  debug: (...a) => emit('debug', ...a),
  info: (...a) => emit('info', ...a),
  warn: (...a) => emit('warn', ...a),
  error: (...a) => emit('error', ...a),
};
