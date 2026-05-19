const ILLEGAL = /[/\\:*?"<>|\x00-\x1f]/g;
const DEFAULT_MAX = 200;

export function sanitizeFilename(input, { maxLength = DEFAULT_MAX, fallback = 'video' } = {}) {
  if (input == null) return fallback;
  let s = String(input)
    .replace(ILLEGAL, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '');
  if (!s) return fallback;
  if (s.length > maxLength) s = s.slice(0, maxLength).trimEnd();
  return s;
}
