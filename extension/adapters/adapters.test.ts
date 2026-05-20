import { describe, it, expect } from 'vitest';
import { pickAdapter, getAdapter, ADAPTERS } from './index.js';
import hotmart from './hotmart.js';
import youtube, {
  buildStreamsFromPlayerResponse,
  parseYtPlayerResponseFromScript,
} from './youtube.js';
import defaultAdapter from './default.js';

describe('pickAdapter', () => {
  it('picks hotmart on hotmart.com club lessons', () => {
    expect(pickAdapter('https://hotmart.com/abc/club/123', '').id).toBe('hotmart');
    expect(pickAdapter('https://app.hotmart.com/abc/club/123', '').id).toBe('hotmart');
  });

  it('falls back to default on non-club hotmart pages', () => {
    expect(pickAdapter('https://hotmart.com/abc/sales', '').id).toBe('default');
    expect(pickAdapter('https://hotmart.com/', '').id).toBe('default');
  });

  it('does not match imposter hosts ending in hotmart.com', () => {
    expect(pickAdapter('https://evilhotmart.com/x/club/1', '').id).toBe('default');
    expect(pickAdapter('https://not-hotmart.com/x/club/1', '').id).toBe('default');
  });

  it('default adapter matches any URL as fallback', () => {
    expect(pickAdapter('https://example.com/anything', '').id).toBe('default');
    expect(pickAdapter('', '').id).toBe('default');
  });

  it('falls back to default when pageUrl is empty, regardless of mediaUrl', () => {
    // If handleDetection ever reaches pickAdapter without a resolved pageUrl
    // (e.g. SW startup race), we intentionally fall back to default — adapter
    // selection is keyed on the page, not the media URL. The seedTabs() await
    // in the SW is what prevents this from happening on real Hotmart pages.
    expect(pickAdapter('', 'https://vod-akm.play.hotmart.com/video/x.m3u8').id).toBe('default');
  });
});

describe('getAdapter', () => {
  it('returns the named adapter when registered', () => {
    expect(getAdapter('hotmart')).toBe(hotmart);
    expect(getAdapter('youtube')).toBe(youtube);
    expect(getAdapter('default')).toBe(defaultAdapter);
  });
  it('returns default for unknown ids', () => {
    expect(getAdapter('unknown-site')).toBe(defaultAdapter);
  });
});

describe('youtube.matches', () => {
  it('picks youtube on canonical watch / shorts / embed / live paths', () => {
    expect(pickAdapter('https://www.youtube.com/watch?v=abc', '').id).toBe('youtube');
    expect(pickAdapter('https://www.youtube.com/shorts/abc', '').id).toBe('youtube');
    expect(pickAdapter('https://www.youtube.com/embed/abc', '').id).toBe('youtube');
    expect(pickAdapter('https://www.youtube.com/live/abc', '').id).toBe('youtube');
    expect(pickAdapter('https://youtube.com/watch?v=abc', '').id).toBe('youtube');
    expect(pickAdapter('https://m.youtube.com/watch?v=abc', '').id).toBe('youtube');
  });

  it('picks youtube on youtu.be short links', () => {
    expect(pickAdapter('https://youtu.be/abc123', '').id).toBe('youtube');
  });

  it('falls back to default on non-video YouTube pages', () => {
    expect(pickAdapter('https://www.youtube.com/', '').id).toBe('default');
    expect(pickAdapter('https://www.youtube.com/feed/subscriptions', '').id).toBe('default');
    expect(pickAdapter('https://www.youtube.com/@channelhandle', '').id).toBe('default');
    // Bare youtu.be host with no video id is meaningless — default.
    expect(pickAdapter('https://youtu.be/', '').id).toBe('default');
  });

  it('does not match imposter hosts', () => {
    expect(pickAdapter('https://evilyoutube.com/watch?v=abc', '').id).toBe('default');
    expect(pickAdapter('https://youtube.com.evil.example/watch?v=abc', '').id).toBe('default');
    expect(pickAdapter('https://youtu.be.evil.example/abc', '').id).toBe('default');
  });
});

describe('youtube.deriveFilename', () => {
  it('prefixes channel when both channelTitle and title present', () => {
    expect(
      youtube.deriveFilename({
        url: '',
        pageMeta: { title: 'Some Video', channelTitle: 'A Channel' },
      }),
    ).toBe('A Channel - Some Video');
  });

  it('uses just the title when channelTitle is missing', () => {
    expect(
      youtube.deriveFilename({
        url: '',
        pageMeta: { title: 'Some Video' },
      }),
    ).toBe('Some Video');
  });

  it('sanitizes illegal characters', () => {
    expect(
      youtube.deriveFilename({
        url: '',
        pageMeta: { title: 'Some / Video : Title?' },
      }),
    ).not.toMatch(/[/:?]/);
  });

  it('falls back to the stub default when meta is empty', () => {
    expect(youtube.deriveFilename({ url: '', pageMeta: {} })).toBe('youtube-video');
  });
});

describe('parseYtPlayerResponseFromScript', () => {
  const sample = `
    var foo = 1;
    var ytInitialPlayerResponse = {"videoDetails":{"videoId":"abc","title":"Hello \\"World\\"","author":"A Channel","lengthSeconds":"42"},"microformat":{"playerMicroformatRenderer":{"ownerChannelName":"A Channel"}}};
    (function() {})();
  `;

  it('extracts videoDetails from a typical YouTube watch-page script', () => {
    const parsed = parseYtPlayerResponseFromScript(sample);
    expect(parsed).not.toBeNull();
    expect(parsed?.videoDetails?.videoId).toBe('abc');
    expect(parsed?.videoDetails?.author).toBe('A Channel');
    expect(parsed?.videoDetails?.title).toBe('Hello "World"');
  });

  it('handles the window["..."] = {...} form', () => {
    const text = `window["ytInitialPlayerResponse"] = {"videoDetails":{"videoId":"xyz"}};`;
    expect(parseYtPlayerResponseFromScript(text)?.videoDetails?.videoId).toBe('xyz');
  });

  it('returns null when the needle is absent', () => {
    expect(parseYtPlayerResponseFromScript('var something = {"a": 1};')).toBeNull();
  });

  it('returns null when the JSON is malformed', () => {
    // Truncated payload — the brace walker still finds a close, but JSON
    // parse fails on the bad string literal.
    expect(parseYtPlayerResponseFromScript('ytInitialPlayerResponse = {"a": "broken}')).toBeNull();
  });

  it('handles escaped quotes inside strings without confusing the bracket walker', () => {
    const text = `ytInitialPlayerResponse = {"videoDetails":{"title":"a } and a { inside"}};`;
    expect(parseYtPlayerResponseFromScript(text)?.videoDetails?.title).toBe('a } and a { inside');
  });
});

describe('buildStreamsFromPlayerResponse', () => {
  it('returns empty when player is null', () => {
    expect(buildStreamsFromPlayerResponse(null)).toEqual([]);
  });

  it('returns empty when playabilityStatus is not OK', () => {
    expect(
      buildStreamsFromPlayerResponse({
        playabilityStatus: { status: 'UNPLAYABLE' },
        streamingData: { formats: [{ itag: 18, url: 'https://x', mimeType: 'video/mp4' }] },
      }),
    ).toEqual([]);
  });

  it('returns one stream with video variants sorted by bandwidth descending', () => {
    const out = buildStreamsFromPlayerResponse({
      videoDetails: { videoId: 'abc', lengthSeconds: '42' },
      streamingData: {
        formats: [
          {
            itag: 18,
            url: 'https://x/18',
            mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"',
            bitrate: 500_000,
            width: 640,
            height: 360,
            contentLength: '1234567',
          },
        ],
        adaptiveFormats: [
          {
            itag: 137,
            url: 'https://x/137',
            mimeType: 'video/mp4; codecs="avc1.640028"',
            bitrate: 4_500_000,
            width: 1920,
            height: 1080,
            contentLength: '9876543',
          },
          {
            itag: 140,
            url: 'https://x/140',
            mimeType: 'audio/mp4; codecs="mp4a.40.2"',
            bitrate: 128_000,
            contentLength: '512000',
          },
        ],
      },
    });
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('dash');
    expect(out[0].url).toBe('youtube:abc');
    expect(out[0].totalDuration).toBe(42);
    // Two video variants, sorted by bandwidth descending. Audio (itag
    // 140) is excluded — the downloader pairs it internally.
    expect(out[0].variants).toHaveLength(2);
    expect(out[0].variants?.[0].url).toBe('https://x/137');
    expect(out[0].variants?.[0].resolution).toBe('1920x1080');
    expect(out[0].variants?.[0].contentLength).toBe(9876543);
    expect(out[0].variants?.[1].url).toBe('https://x/18');
  });

  it('skips formats without a direct url (signatureCipher path is deferred)', () => {
    const out = buildStreamsFromPlayerResponse({
      videoDetails: { videoId: 'xyz' },
      streamingData: {
        adaptiveFormats: [
          {
            itag: 137,
            signatureCipher: 's=AAA&sp=sig&url=https%3A%2F%2Fexample',
            mimeType: 'video/mp4',
            bitrate: 4_500_000,
            width: 1920,
            height: 1080,
          },
        ],
      },
    });
    // All formats gated by signatureCipher → no playable variants → empty.
    expect(out).toEqual([]);
  });

  it('falls back to the first variant url when videoId is missing', () => {
    const out = buildStreamsFromPlayerResponse({
      streamingData: {
        formats: [
          {
            itag: 18,
            url: 'https://x/18',
            // H.264 codec is required by the v0.11 filter — bare
            // "video/mp4" without a codecs= attribute is rejected.
            mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"',
            bitrate: 500_000,
            width: 640,
            height: 360,
          },
        ],
      },
    });
    expect(out[0].url).toBe('https://x/18');
  });

  it('pairs adaptive video variants with the highest-bitrate AAC audio', () => {
    const out = buildStreamsFromPlayerResponse({
      videoDetails: { videoId: 'abc' },
      streamingData: {
        formats: [
          {
            itag: 18,
            url: 'https://x/18',
            mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"',
            bitrate: 500_000,
            width: 640,
            height: 360,
          },
        ],
        adaptiveFormats: [
          {
            itag: 137,
            url: 'https://x/137',
            mimeType: 'video/mp4; codecs="avc1.640028"',
            bitrate: 4_500_000,
            width: 1920,
            height: 1080,
            contentLength: '9876543',
          },
          {
            itag: 140,
            url: 'https://x/140-aac-128',
            mimeType: 'audio/mp4; codecs="mp4a.40.2"',
            bitrate: 128_000,
            contentLength: '512000',
          },
          {
            itag: 139,
            url: 'https://x/139-aac-48',
            mimeType: 'audio/mp4; codecs="mp4a.40.2"',
            bitrate: 48_000,
            contentLength: '256000',
          },
        ],
      },
    });
    // Adaptive variant (itag=137) gets the higher-bitrate audio paired.
    const adaptive = out[0].variants?.find((v) => v.url === 'https://x/137');
    expect(adaptive?.pairedAudioUrl).toBe('https://x/140-aac-128');
    expect(adaptive?.pairedAudioContentLength).toBe(512000);
    // Progressive itag (itag=18) already has muxed audio — no pairing.
    const progressive = out[0].variants?.find((v) => v.url === 'https://x/18');
    expect(progressive?.pairedAudioUrl).toBeUndefined();
  });

  it('omits pairedAudioUrl when no compatible audio format exists', () => {
    const out = buildStreamsFromPlayerResponse({
      videoDetails: { videoId: 'abc' },
      streamingData: {
        adaptiveFormats: [
          {
            itag: 137,
            url: 'https://x/137',
            mimeType: 'video/mp4; codecs="avc1.640028"',
            bitrate: 4_500_000,
            width: 1920,
            height: 1080,
          },
          // Only opus audio — v0.11's H.264+AAC-only filter excludes
          // it, so the variant ends up with no paired audio. The
          // adaptive download path will recognize this and surface a
          // typed error rather than silently producing a video-only
          // file.
          {
            itag: 251,
            url: 'https://x/251',
            mimeType: 'audio/webm; codecs="opus"',
            bitrate: 160_000,
          },
        ],
      },
    });
    expect(out[0].variants?.[0].pairedAudioUrl).toBeUndefined();
  });

  it('skips VP9 / AV1 video formats (v0.11 ships H.264-only)', () => {
    const out = buildStreamsFromPlayerResponse({
      videoDetails: { videoId: 'abc' },
      streamingData: {
        adaptiveFormats: [
          {
            itag: 248,
            url: 'https://x/248',
            mimeType: 'video/webm; codecs="vp09.00.40.08"',
            bitrate: 3_000_000,
            width: 1920,
            height: 1080,
          },
          {
            itag: 401,
            url: 'https://x/401',
            mimeType: 'video/mp4; codecs="av01.0.13M.08"',
            bitrate: 5_000_000,
            width: 3840,
            height: 2160,
          },
        ],
      },
    });
    expect(out).toEqual([]);
  });
});

describe('ADAPTERS ordering', () => {
  it('lists specific adapters before the default fallback', () => {
    const idx = ADAPTERS.findIndex((a) => a.id === 'default');
    expect(idx).toBe(ADAPTERS.length - 1);
  });
});

describe('default.deriveFilename', () => {
  it('sanitizes title with illegal chars', () => {
    const name = defaultAdapter.deriveFilename({
      pageMeta: { title: 'Hello / World : Best?' },
      url: 'https://x.com/path/video.mp4',
    });
    expect(name).not.toMatch(/[/:?]/);
    expect(name).toContain('video');
  });

  it('falls back to URL basename when title missing', () => {
    const name = defaultAdapter.deriveFilename({
      pageMeta: { title: '' },
      url: 'https://x.com/path/clip.mp4',
    });
    expect(name).toBe('clip');
  });
});

describe('hotmart.deriveFilename', () => {
  it('formats as "{section} - {lesson}" when both present', () => {
    expect(
      hotmart.deriveFilename({
        url: '',
        pageMeta: { sectionTitle: 'Porta de Entrada', lessonTitle: 'Lição 3' },
      }),
    ).toBe('Porta de Entrada - Lição 3');
  });

  it('falls back to lesson, then title, then literal', () => {
    expect(hotmart.deriveFilename({ url: '', pageMeta: { lessonTitle: 'Lição 1' } })).toBe(
      'Lição 1',
    );
    expect(hotmart.deriveFilename({ url: '', pageMeta: { title: 'just-a-title' } })).toBe(
      'just-a-title',
    );
    expect(hotmart.deriveFilename({ url: '', pageMeta: {} })).toBe('hotmart-lesson');
  });

  it('sanitizes illegal chars in lesson titles', () => {
    const name = hotmart.deriveFilename({
      url: '',
      pageMeta: { sectionTitle: 'a/b', lessonTitle: 'c:d' },
    });
    expect(name).not.toMatch(/[/:]/);
  });
});
