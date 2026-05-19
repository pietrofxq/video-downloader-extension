// Chunked base64 encoder/decoder. Used to ship binary segment + key bodies
// through chrome.runtime messaging, which serializes to JSON and doesn't
// preserve ArrayBuffers natively.

const CHUNK = 0x8000; // 32 KB — apply.length cap is ~64K; halving for safety

export function uint8ArrayToBase64(u8) {
  if (!(u8 instanceof Uint8Array)) {
    throw new TypeError('uint8ArrayToBase64: expected Uint8Array');
  }
  let bin = '';
  for (let i = 0; i < u8.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function base64ToUint8Array(s) {
  if (typeof s !== 'string') {
    throw new TypeError('base64ToUint8Array: expected string');
  }
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
