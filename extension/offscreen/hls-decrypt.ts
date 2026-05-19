// AES-128-CBC decryption helpers for HLS segments. Uses Web Crypto's
// SubtleCrypto, which is available in offscreen documents (same as in the
// main thread) and handles PKCS#7 padding automatically.

// Derive a 16-byte IV from an HLS media-sequence number when the
// EXT-X-KEY tag doesn't supply one. The spec mandates big-endian byte
// order with the sequence number occupying the LOW 8 bytes (high 8 are 0).
export function ivFromSequence(sequenceNumber: number): Uint8Array {
  if (!Number.isFinite(sequenceNumber) || sequenceNumber < 0) {
    throw new RangeError('ivFromSequence: sequenceNumber must be a non-negative number');
  }
  const iv = new Uint8Array(16);
  // Big-endian write of sequence into the low 8 bytes (offset 8..15).
  // setBigUint64 with `false` for little-endian gives big-endian. Negative
  // BigInts aren't valid here; the > 0 guard above ensures BigInt() succeeds.
  // The `as ArrayBuffer` cast is for TS 6.0's stricter Uint8Array<ArrayBufferLike>
  // generic — the underlying buffer of a freshly-allocated Uint8Array is always
  // an ArrayBuffer (never a SharedArrayBuffer).
  new DataView(iv.buffer as ArrayBuffer).setBigUint64(8, BigInt(sequenceNumber), false);
  return iv;
}

// Normalize a key/IV input that might be either a Uint8Array or one of
// m3u8-parser's Uint32Array IV representations into a 16-byte Uint8Array.
//
// m3u8-parser stores parsed `IV=0x...` values as a 4-element Uint32Array
// where each element is a JS Number (host-byte-order in memory). On
// little-endian platforms (Chrome, Node on x86/ARM), reinterpreting the
// underlying buffer as Uint8Array would give bytes in the wrong order:
// IV `0x...0001` becomes `01 00 00 00` instead of `00 00 00 01`, and any
// stream with an explicit EXT-X-KEY:IV= decrypts to garbage. We must
// serialize each Uint32 word big-endian, which is the order HLS requires.
export function toUint8(
  input: ArrayBufferView | ArrayBuffer | null | undefined,
): Uint8Array | null {
  if (!input) return null;
  if (input instanceof Uint8Array) return input;
  if (input instanceof Uint32Array) {
    const out = new Uint8Array(input.length * 4);
    const view = new DataView(out.buffer as ArrayBuffer);
    for (let i = 0; i < input.length; i += 1) {
      view.setUint32(i * 4, input[i] >>> 0, false); // big-endian
    }
    return out;
  }
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer as ArrayBuffer, input.byteOffset, input.byteLength);
  }
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  return null;
}

export async function importAesKey(keyBytes: Uint8Array): Promise<CryptoKey> {
  if (!(keyBytes instanceof Uint8Array) || keyBytes.length !== 16) {
    throw new RangeError('importAesKey: expected a 16-byte Uint8Array');
  }
  return crypto.subtle.importKey(
    'raw',
    keyBytes as Uint8Array<ArrayBuffer>,
    { name: 'AES-CBC' },
    false,
    ['decrypt'],
  );
}

export async function decryptSegment(
  ciphertext: Uint8Array,
  key: CryptoKey,
  iv: Uint8Array,
): Promise<Uint8Array> {
  if (!(iv instanceof Uint8Array) || iv.length !== 16) {
    throw new RangeError('decryptSegment: iv must be a 16-byte Uint8Array');
  }
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-CBC', iv: iv as Uint8Array<ArrayBuffer> },
    key,
    ciphertext as Uint8Array<ArrayBuffer>,
  );
  return new Uint8Array(plaintext);
}
