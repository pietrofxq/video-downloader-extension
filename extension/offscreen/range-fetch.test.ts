import { describe, it, expect, vi } from 'vitest';

import { DEFAULT_CHUNK_BYTES, fetchArrayBufferRanged, parseTotalSize } from './range-fetch.js';
import { uint8ArrayToBase64 } from '../lib/base64.js';
import type { ProxyFetch, ProxyFetchPayload, ProxyFetchReply } from './downloader.js';

// ---------- parseTotalSize ----------

describe('parseTotalSize', () => {
  it('prefers Content-Range total', () => {
    expect(parseTotalSize({ contentRange: 'bytes 0-99/12345' }, 100)).toEqual({
      total: 12345,
      known: true,
    });
  });
  it('treats Content-Length as the total ONLY when status is 200 OK', () => {
    expect(parseTotalSize({ status: 200, contentLength: 9876 }, 0)).toEqual({
      total: 9876,
      known: true,
    });
  });
  it('does NOT trust Content-Length on a 206 response with Content-Range stripped', () => {
    // The cross-origin CORS case: server returned 206 partial with
    // Content-Range, but the browser stripped it (not on the CORS
    // safelist). Content-Length here is the chunk size we asked
    // for, not the file total. Previous parser treated this as
    // `known: true` and truncated 1080p videos at one chunk.
    expect(parseTotalSize({ status: 206, contentLength: 8388608 }, 8388608)).toEqual({
      total: 8388608,
      known: false,
    });
  });
  it('reports unknown when Content-Range is present but total is `*`', () => {
    expect(parseTotalSize({ contentRange: 'bytes 0-99/*', contentLength: 100 }, 100)).toEqual({
      total: 100,
      known: false,
    });
  });
  it('reports unknown when no headers help', () => {
    expect(parseTotalSize({}, 42)).toEqual({ total: 42, known: false });
  });
});

// ---------- fetchArrayBufferRanged ----------
//
// We mock the ProxyFetch surface. Each call inspects the Range header
// and returns the matching slice of a pre-built buffer + a synthetic
// Content-Range header that the helper uses to learn total size.

function makeBuffer(size: number): Uint8Array {
  const buf = new Uint8Array(size);
  // Deterministic pattern so we can assert reassembly later.
  for (let i = 0; i < size; i += 1) buf[i] = (i * 37) & 0xff;
  return buf;
}

function parseRange(header: string | undefined): { from: number; to: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d+)-(\d+)$/.exec(header);
  if (!m) return null;
  return { from: Number(m[1]), to: Number(m[2]) };
}

function makeProxy(buffer: Uint8Array): {
  proxy: ProxyFetch;
  spy: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn(async (payload: ProxyFetchPayload): Promise<ProxyFetchReply> => {
    const rng = parseRange(payload.headers?.Range);
    if (!rng) {
      // Server returns full body (no Range respected).
      return {
        ok: true,
        status: 200,
        body: uint8ArrayToBase64(buffer),
        contentLength: buffer.byteLength,
      };
    }
    const from = rng.from;
    const to = Math.min(rng.to, buffer.byteLength - 1);
    const slice = buffer.subarray(from, to + 1);
    return {
      ok: true,
      status: 206,
      body: uint8ArrayToBase64(slice),
      contentLength: slice.byteLength,
      contentRange: `bytes ${from}-${to}/${buffer.byteLength}`,
    };
  });
  return { proxy: spy as unknown as ProxyFetch, spy };
}

// Equality check that doesn't materialize the buffer as a JS Array
// (Array.from on a multi-MB Uint8Array blows Node's heap during the
// vitest worker — observed 2 GB+ allocation failure on 2.5 MB inputs).
function expectBytesEqual(got: Uint8Array, expected: Uint8Array): void {
  expect(got.byteLength).toBe(expected.byteLength);
  // Sample a few offsets across the buffer; combined with byteLength
  // this catches off-by-one chunk boundaries + interleaving bugs
  // without comparing millions of array slots.
  const probes = [
    0,
    1,
    Math.floor(expected.byteLength / 4),
    Math.floor(expected.byteLength / 2),
    Math.floor((expected.byteLength * 3) / 4),
    expected.byteLength - 2,
    expected.byteLength - 1,
  ];
  for (const i of probes) {
    if (i < 0 || i >= expected.byteLength) continue;
    expect(got[i]).toBe(expected[i]);
  }
}

describe('fetchArrayBufferRanged', () => {
  it('returns the whole body unchanged for a small file (one chunk)', async () => {
    const expected = makeBuffer(1024);
    const { proxy } = makeProxy(expected);
    const got = await fetchArrayBufferRanged({
      proxyFetch: proxy,
      tabId: 1,
      frameId: 0,
      url: 'https://example.com/small',
      chunkBytes: 4096,
    });
    expectBytesEqual(got, expected);
  });

  it('reassembles multi-chunk responses in order', async () => {
    // Sizes kept small (KB scale) — we only need to exercise the
    // chunking *logic*; allocating MB-scale buffers under vitest's
    // node worker has tripped OOM during base64 encode.
    const expected = makeBuffer(2500);
    const { proxy, spy } = makeProxy(expected);
    const got = await fetchArrayBufferRanged({
      proxyFetch: proxy,
      tabId: 1,
      frameId: 0,
      url: 'https://example.com/big',
      chunkBytes: 1000, // 1 KB chunks → 3 chunks expected
    });
    expectBytesEqual(got, expected);
    expect(spy).toHaveBeenCalledTimes(3);
    const ranges = spy.mock.calls.map((c) => (c[0] as ProxyFetchPayload).headers?.Range);
    expect(ranges).toEqual(['bytes=0-999', 'bytes=1000-1999', 'bytes=2000-2499']);
  });

  it('reports onProgress per chunk with monotonic totals', async () => {
    const expected = makeBuffer(2500);
    const { proxy } = makeProxy(expected);
    const onProgress = vi.fn();
    await fetchArrayBufferRanged({
      proxyFetch: proxy,
      tabId: 1,
      frameId: 0,
      url: 'https://example.com/big',
      chunkBytes: 1000,
      onProgress,
    });
    const calls = onProgress.mock.calls.map(
      ([written, total]) => [written, total] as [number, number],
    );
    expect(calls).toEqual([
      [1000, 2500],
      [2000, 2500],
      [2500, 2500],
    ]);
  });

  it('uses the default chunk size when not overridden', async () => {
    // Only assert the first range header value — we don't allocate
    // an 8 MB buffer just to verify the constant defaults correctly.
    const expected = makeBuffer(100);
    const { proxy, spy } = makeProxy(expected);
    await fetchArrayBufferRanged({
      proxyFetch: proxy,
      tabId: 1,
      frameId: 0,
      url: 'https://example.com/big',
    });
    // Single chunk because total fits inside DEFAULT_CHUNK_BYTES.
    expect(spy).toHaveBeenCalledTimes(1);
    expect((spy.mock.calls[0][0] as ProxyFetchPayload).headers?.Range).toBe(
      `bytes=0-${DEFAULT_CHUNK_BYTES - 1}`,
    );
  });

  it('throws when a chunk fails', async () => {
    const spy = vi.fn(async (payload: ProxyFetchPayload): Promise<ProxyFetchReply> => {
      const rng = parseRange(payload.headers?.Range);
      if (rng && rng.from === 0) {
        return {
          ok: true,
          status: 206,
          body: uint8ArrayToBase64(new Uint8Array(1024)),
          contentRange: 'bytes 0-1023/3000',
        };
      }
      return { ok: false, status: 403, error: 'gone' };
    });
    await expect(
      fetchArrayBufferRanged({
        proxyFetch: spy as unknown as ProxyFetch,
        tabId: 1,
        frameId: 0,
        url: 'https://example.com/big',
        chunkBytes: 1024,
      }),
    ).rejects.toThrow();
  });

  it('handles a server that ignores Range and returns the full body', async () => {
    const expected = makeBuffer(50_000);
    // Build a "no Range support" proxy: every call returns the
    // entire body with no Content-Range header.
    const proxy = vi.fn(async (): Promise<ProxyFetchReply> => {
      return {
        ok: true,
        status: 200,
        body: uint8ArrayToBase64(expected),
        contentLength: expected.byteLength,
      };
    }) as unknown as ProxyFetch;
    const got = await fetchArrayBufferRanged({
      proxyFetch: proxy,
      tabId: 1,
      frameId: 0,
      url: 'https://example.com/full',
      chunkBytes: 1024,
    });
    expectBytesEqual(got, expected);
  });

  it('keeps fetching when Content-Range total is `*` until a short chunk', async () => {
    // Simulate a server that doesn't publish total size up-front
    // (the bug scenario from the v0.11.3 first-real-1080p test).
    const expected = makeBuffer(2500);
    const spy = vi.fn(async (payload: ProxyFetchPayload): Promise<ProxyFetchReply> => {
      const rng = parseRange(payload.headers?.Range)!;
      const from = rng.from;
      const to = Math.min(rng.to, expected.byteLength - 1);
      if (from >= expected.byteLength) {
        return { ok: false, status: 416, error: 'past EOF' };
      }
      const slice = expected.subarray(from, to + 1);
      return {
        ok: true,
        status: 206,
        body: uint8ArrayToBase64(slice),
        contentLength: slice.byteLength,
        contentRange: `bytes ${from}-${to}/*`, // total unknown
      };
    });
    const got = await fetchArrayBufferRanged({
      proxyFetch: spy as unknown as ProxyFetch,
      tabId: 1,
      frameId: 0,
      url: 'https://example.com/unknown-total',
      chunkBytes: 1000,
    });
    expectBytesEqual(got, expected);
    // 3 chunks: bytes 0-999 (full), 1000-1999 (full), 2000-2999
    // (short — 500 bytes returned → EOF detected).
    expect(spy).toHaveBeenCalledTimes(3);
    const ranges = spy.mock.calls.map((c) => (c[0] as ProxyFetchPayload).headers?.Range);
    expect(ranges).toEqual(['bytes=0-999', 'bytes=1000-1999', 'bytes=2000-2999']);
  });

  it('stops on 416 when the previous chunk landed exactly on EOF', async () => {
    // 1000 bytes total, 1000 byte chunks → the first chunk
    // delivers everything; the second range request lands past EOF
    // and the server returns 416. Helper must treat that as
    // termination (not propagate as an error).
    const expected = makeBuffer(1000);
    const spy = vi.fn(async (payload: ProxyFetchPayload): Promise<ProxyFetchReply> => {
      const rng = parseRange(payload.headers?.Range)!;
      if (rng.from >= expected.byteLength) {
        return { ok: false, status: 416, error: 'past EOF' };
      }
      const from = rng.from;
      const to = Math.min(rng.to, expected.byteLength - 1);
      return {
        ok: true,
        status: 206,
        body: uint8ArrayToBase64(expected.subarray(from, to + 1)),
        contentLength: to - from + 1,
        contentRange: `bytes ${from}-${to}/*`, // unknown total
      };
    });
    const got = await fetchArrayBufferRanged({
      proxyFetch: spy as unknown as ProxyFetch,
      tabId: 1,
      frameId: 0,
      url: 'https://example.com/exact-boundary',
      chunkBytes: 1000,
    });
    expectBytesEqual(got, expected);
    // First chunk returns the whole body (1000 bytes); we ask for
    // the next chunk, get 416, terminate cleanly.
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('honors AbortSignal mid-stream', async () => {
    const expected = makeBuffer(100_000);
    const ctrl = new AbortController();
    let chunkCount = 0;
    const spy = vi.fn(async (payload: ProxyFetchPayload): Promise<ProxyFetchReply> => {
      const rng = parseRange(payload.headers?.Range)!;
      chunkCount += 1;
      // Abort synchronously inside the first response so the loop's
      // next throwIfAborted fires before any further chunk is issued.
      if (chunkCount === 1) {
        ctrl.abort(new DOMException('canceled', 'AbortError'));
      }
      const from = rng.from;
      const to = Math.min(rng.to, expected.byteLength - 1);
      return {
        ok: true,
        status: 206,
        body: uint8ArrayToBase64(expected.subarray(from, to + 1)),
        contentRange: `bytes ${from}-${to}/${expected.byteLength}`,
      };
    });
    await expect(
      fetchArrayBufferRanged({
        proxyFetch: spy as unknown as ProxyFetch,
        tabId: 1,
        frameId: 0,
        url: 'https://example.com/big',
        chunkBytes: 10_000,
        signal: ctrl.signal,
      }),
    ).rejects.toThrow(/cancel/i);
  });
});
