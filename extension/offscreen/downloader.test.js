import { describe, it, expect } from 'vitest';
import { parsePlaylist } from './downloader.js';

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
    expect(Array.from(segments[0].iv)).toEqual([
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
