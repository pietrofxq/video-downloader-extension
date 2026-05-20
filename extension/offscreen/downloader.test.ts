import { describe, it, expect, vi } from 'vitest';
import {
  PROGRESS_WEIGHTS,
  computeUnifiedProgress,
  isRetryableReply,
  parsePlaylist,
  proxyFetchWithRetry,
} from './downloader.js';
import type { ProxyFetch, ProxyFetchReply } from './downloader.js';

// The five scenarios from the v0.8.1 ship criterion. These exercise the
// downloader's parse step — the gate that decides whether a playlist can
// safely feed the rest of the pipeline. The post-parse stages (segment
// fetch, AES-CBC decrypt, mux.js remux) need real MPEG-TS fixtures and
// live in remux.test.js / hls-decrypt.test.js / future integration tests.

const BASE = 'https://cdn.example.com/v/master/';

describe('parsePlaylist — unencrypted public HLS', () => {
  it('returns the media segments with encrypted=false', () => {
    const text =
      '#EXTM3U\n' +
      '#EXT-X-VERSION:3\n' +
      '#EXT-X-TARGETDURATION:6\n' +
      '#EXT-X-MEDIA-SEQUENCE:0\n' +
      '#EXTINF:6.0,\n' +
      'seg-0.ts\n' +
      '#EXTINF:6.0,\n' +
      'seg-1.ts\n' +
      '#EXT-X-ENDLIST\n';
    const { isMaster, segments } = parsePlaylist(text, BASE);
    expect(isMaster).toBe(false);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({
      url: `${BASE}seg-0.ts`,
      sequence: 0,
      encrypted: false,
      keyUrl: '',
    });
    expect(segments[1]).toMatchObject({ url: `${BASE}seg-1.ts`, sequence: 1, encrypted: false });
  });

  it('treats EXT-X-KEY METHOD=NONE as pass-through (no encryption)', () => {
    const text =
      '#EXTM3U\n' +
      '#EXT-X-VERSION:3\n' +
      '#EXT-X-TARGETDURATION:6\n' +
      '#EXT-X-KEY:METHOD=NONE\n' +
      '#EXTINF:6.0,\n' +
      'seg.ts\n' +
      '#EXT-X-ENDLIST\n';
    const { segments } = parsePlaylist(text, BASE);
    expect(segments[0].encrypted).toBe(false);
  });
});

describe('parsePlaylist — AES-128 with implicit IV', () => {
  it('flags segments as encrypted and resolves the key URL', () => {
    const text =
      '#EXTM3U\n' +
      '#EXT-X-VERSION:3\n' +
      '#EXT-X-TARGETDURATION:6\n' +
      '#EXT-X-MEDIA-SEQUENCE:42\n' +
      '#EXT-X-KEY:METHOD=AES-128,URI="../keys/abc.key"\n' +
      '#EXTINF:6.0,\n' +
      'seg-42.ts\n' +
      '#EXTINF:6.0,\n' +
      'seg-43.ts\n' +
      '#EXT-X-ENDLIST\n';
    const { segments } = parsePlaylist(text, BASE);
    expect(segments[0].encrypted).toBe(true);
    expect(segments[0].keyUrl).toBe('https://cdn.example.com/v/keys/abc.key');
    // sequence = mediaSequence + index (NOT timeline/discontinuity counter).
    expect(segments[0].sequence).toBe(42);
    expect(segments[1].sequence).toBe(43);
    // No explicit IV → null; decrypt path falls back to ivFromSequence(seq).
    expect(segments[0].iv).toBeNull();
  });
});

describe('parsePlaylist — AES-128 with explicit IV', () => {
  it('preserves the parser-supplied IV (big-endian bytes from toUint8)', () => {
    const text =
      '#EXTM3U\n' +
      '#EXT-X-VERSION:3\n' +
      '#EXT-X-TARGETDURATION:6\n' +
      '#EXT-X-KEY:METHOD=AES-128,URI="k",IV=0x000102030405060708090A0B0C0D0E0F\n' +
      '#EXTINF:6.0,\n' +
      'seg.ts\n' +
      '#EXT-X-ENDLIST\n';
    const { segments } = parsePlaylist(text, BASE);
    expect(segments[0].iv).toBeInstanceOf(Uint8Array);
    expect(Array.from(segments[0].iv!)).toEqual([
      0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e,
      0x0f,
    ]);
  });
});

describe('parsePlaylist — malformed manifest', () => {
  it('rejects a body that does not start with #EXTM3U (e.g. HTML 403 page)', () => {
    expect(() => parsePlaylist('<html><body>403 forbidden</body></html>', BASE)).toThrow(
      /Not an HLS manifest/i,
    );
  });

  it('rejects an empty string', () => {
    expect(() => parsePlaylist('', BASE)).toThrow();
  });

  it('rejects non-string input', () => {
    expect(() => parsePlaylist(null, BASE)).toThrow();
    expect(() => parsePlaylist(undefined, BASE)).toThrow();
  });
});

describe('parsePlaylist — unsupported encryption methods', () => {
  it('throws DRMProtectedError for SAMPLE-AES (FairPlay-style)', () => {
    const text =
      '#EXTM3U\n' +
      '#EXT-X-VERSION:5\n' +
      '#EXT-X-TARGETDURATION:6\n' +
      '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://drm",KEYFORMAT="com.apple.streamingkeydelivery"\n' +
      '#EXTINF:6.0,\n' +
      'seg.ts\n' +
      '#EXT-X-ENDLIST\n';
    expect(() => parsePlaylist(text, BASE)).toThrow(/DRM|SAMPLE-AES|not supported/i);
  });

  it('throws DRMProtectedError for SAMPLE-AES-CTR', () => {
    const text =
      '#EXTM3U\n' +
      '#EXT-X-VERSION:7\n' +
      '#EXT-X-TARGETDURATION:6\n' +
      '#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,URI="k"\n' +
      '#EXTINF:6.0,\n' +
      'seg.ts\n' +
      '#EXT-X-ENDLIST\n';
    expect(() => parsePlaylist(text, BASE)).toThrow(/SAMPLE-AES-CTR|not supported/i);
  });

  it('throws UnsupportedFormatError for unknown methods', () => {
    const text =
      '#EXTM3U\n' +
      '#EXT-X-VERSION:3\n' +
      '#EXT-X-TARGETDURATION:6\n' +
      '#EXT-X-KEY:METHOD=AES-256,URI="k"\n' +
      '#EXTINF:6.0,\n' +
      'seg.ts\n' +
      '#EXT-X-ENDLIST\n';
    expect(() => parsePlaylist(text, BASE)).toThrow(/Unsupported HLS encryption method/i);
  });
});

describe('computeUnifiedProgress — bar never resets between stages', () => {
  it('starts at 0 and reaches exactly total when all phases finish (encrypted)', () => {
    const N = 30;
    const start = computeUnifiedProgress(N, true, 0, 0, 0);
    expect(start.current).toBe(0);
    const end = computeUnifiedProgress(N, true, N, N, N);
    expect(end.current).toBe(end.total);
  });

  it('starts at 0 and reaches exactly total when all phases finish (unencrypted)', () => {
    const N = 12;
    const start = computeUnifiedProgress(N, false, 0, 0, 0);
    expect(start.current).toBe(0);
    // Production never ticks `decrypted` past 0 on unencrypted streams
    // (the decrypt branch is skipped), so the saturated end state is
    // (N, 0, N) — and the bar still reaches exactly total because the
    // decrypt term drops out of the grand total too.
    const end = computeUnifiedProgress(N, false, N, 0, N);
    expect(end.current).toBe(end.total);
  });

  it('drops decrypt weight from total when no segments are encrypted', () => {
    const N = 10;
    const enc = computeUnifiedProgress(N, true, 0, 0, 0).total;
    const plain = computeUnifiedProgress(N, false, 0, 0, 0).total;
    expect(enc).toBeGreaterThan(plain);
    expect(enc - plain).toBe(N * PROGRESS_WEIGHTS.decrypt);
  });

  it('is monotonically non-decreasing through a full simulated run', () => {
    // Replay the production sequence: fetch 0..N (with concurrent
    // decrypt 0..k where k ≤ fetched), then remux 0..N. The whole
    // sequence must produce a current that never goes down — that's
    // the bug the weighted accounting was added to fix.
    const N = 7;
    const samples: number[] = [];
    let fetched = 0;
    let decrypted = 0;
    for (let i = 1; i <= N; i += 1) {
      fetched = i;
      samples.push(computeUnifiedProgress(N, true, fetched, decrypted, 0).current);
      decrypted = i;
      samples.push(computeUnifiedProgress(N, true, fetched, decrypted, 0).current);
    }
    for (let r = 1; r <= N; r += 1) {
      samples.push(computeUnifiedProgress(N, true, N, N, r).current);
    }
    for (let i = 1; i < samples.length; i += 1) {
      expect(samples[i]).toBeGreaterThanOrEqual(samples[i - 1]);
    }
    // And the last sample saturates the bar.
    expect(samples[samples.length - 1]).toBe(computeUnifiedProgress(N, true, N, N, N).total);
  });

  it('returns zeroed totals for an empty playlist (defensive — downloader rejects this upstream)', () => {
    const got = computeUnifiedProgress(0, true, 0, 0, 0);
    expect(got).toEqual({ current: 0, total: 0 });
  });

  it('honors a custom weights override (lets tests/tools probe alternate schedules)', () => {
    const weights = { fetch: 1, decrypt: 0, remux: 1 };
    const got = computeUnifiedProgress(5, true, 5, 5, 0, weights);
    // decrypt contributes 0 → current = fetched*1 = 5; total = N*(1+0+1) = 10.
    expect(got).toEqual({ current: 5, total: 10 });
  });
});

describe('isRetryableReply — transient-failure policy', () => {
  it('treats a missing reply (proxy threw) as retryable', () => {
    expect(isRetryableReply(undefined)).toBe(true);
  });

  it('does not retry on ok=true', () => {
    expect(isRetryableReply({ ok: true })).toBe(false);
  });

  it('retries 429 and 5xx', () => {
    expect(isRetryableReply({ ok: false, status: 429 })).toBe(true);
    expect(isRetryableReply({ ok: false, status: 500 })).toBe(true);
    expect(isRetryableReply({ ok: false, status: 503 })).toBe(true);
    expect(isRetryableReply({ ok: false, status: 599 })).toBe(true);
  });

  it('retries status=0 (content-script fetch threw)', () => {
    expect(isRetryableReply({ ok: false, status: 0 })).toBe(true);
  });

  it('does NOT retry on non-transient 4xx (403 token-expired, 404)', () => {
    expect(isRetryableReply({ ok: false, status: 403 })).toBe(false);
    expect(isRetryableReply({ ok: false, status: 404 })).toBe(false);
    expect(isRetryableReply({ ok: false, status: 401 })).toBe(false);
  });
});

describe('proxyFetchWithRetry — backoff + cancel policy', () => {
  const url = 'https://cdn.example.com/seg.ts';
  const payload = { tabId: 1, url, responseType: 'arrayBuffer' as const };

  // Replace setTimeout with a synchronous resolver so the test runs fast
  // even with the 500ms · 1s · 2s · 4s backoff schedule.
  function fakeTimers(): { restore: () => void } {
    const orig = globalThis.setTimeout;
    // @ts-expect-error — test-only monkey-patch
    globalThis.setTimeout = (fn: () => void) => {
      Promise.resolve().then(fn);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    };
    return { restore: () => (globalThis.setTimeout = orig) };
  }

  it('stops at the first non-retryable failure (403)', async () => {
    const reply: ProxyFetchReply = { ok: false, status: 403, error: 'forbidden' };
    const proxyFetch = vi.fn<ProxyFetch>().mockResolvedValue(reply);
    const got = await proxyFetchWithRetry(proxyFetch, payload);
    expect(got).toEqual(reply);
    // No retry on 403 → exactly one attempt.
    expect(proxyFetch).toHaveBeenCalledTimes(1);
  });

  it('returns the first successful reply', async () => {
    const ok: ProxyFetchReply = { ok: true, status: 200, body: 'x' };
    const proxyFetch = vi.fn<ProxyFetch>().mockResolvedValue(ok);
    const got = await proxyFetchWithRetry(proxyFetch, payload);
    expect(got).toEqual(ok);
    expect(proxyFetch).toHaveBeenCalledTimes(1);
  });

  it('retries transient failures up to MAX_FETCH_ATTEMPTS (5)', async () => {
    const timers = fakeTimers();
    try {
      const proxyFetch = vi
        .fn<ProxyFetch>()
        .mockResolvedValue({ ok: false, status: 500, error: 'boom' });
      const got = await proxyFetchWithRetry(proxyFetch, payload);
      expect(got.ok).toBe(false);
      expect(got.status).toBe(500);
      // 5 total attempts: 1 initial + 4 retries (sleeps 500ms/1s/2s/4s).
      expect(proxyFetch).toHaveBeenCalledTimes(5);
    } finally {
      timers.restore();
    }
  });

  it('succeeds after a transient blip', async () => {
    const timers = fakeTimers();
    try {
      const proxyFetch = vi
        .fn<ProxyFetch>()
        .mockResolvedValueOnce({ ok: false, status: 503 })
        .mockResolvedValueOnce({ ok: false, status: 0 })
        .mockResolvedValueOnce({ ok: true, status: 200, body: 'finally' });
      const got = await proxyFetchWithRetry(proxyFetch, payload);
      expect(got.ok).toBe(true);
      expect(got.body).toBe('finally');
      expect(proxyFetch).toHaveBeenCalledTimes(3);
    } finally {
      timers.restore();
    }
  });

  it('aborts immediately when the signal fires mid-backoff', async () => {
    const timers = fakeTimers();
    const ac = new AbortController();
    try {
      const proxyFetch = vi.fn<ProxyFetch>().mockImplementation(async () => {
        ac.abort(new Error('canceled'));
        return { ok: false, status: 500 };
      });
      await expect(proxyFetchWithRetry(proxyFetch, payload, ac.signal)).rejects.toThrow('canceled');
      // Only one network attempt before the abort interrupts the backoff sleep.
      expect(proxyFetch).toHaveBeenCalledTimes(1);
    } finally {
      timers.restore();
    }
  });
});

describe('parsePlaylist — master vs media discrimination', () => {
  it('detects a master playlist and yields no segments', () => {
    const text =
      '#EXTM3U\n' +
      '#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=1280x720\n' +
      '720p/playlist.m3u8\n' +
      '#EXT-X-STREAM-INF:BANDWIDTH=2560000,RESOLUTION=1920x1080\n' +
      '1080p/playlist.m3u8\n';
    const { isMaster, segments } = parsePlaylist(text, BASE);
    expect(isMaster).toBe(true);
    expect(segments).toEqual([]);
  });
});
