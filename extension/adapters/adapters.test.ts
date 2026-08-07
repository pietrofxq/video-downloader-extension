import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pickAdapter, getAdapter, ADAPTERS } from './index.js';
import hotmart from './hotmart.js';
import youtube, {
  _clearInnerTubeCacheForTests,
  buildAudioTracks,
  buildStreamsFromPlayerResponse,
  discoverYouTubeStreams,
  fetchInnerTubePlayer,
  mergeInlineIntoInnerTube,
  parseYtPlayerResponseFromScript,
  readVisitorDataFromYtcfg,
} from './youtube.js';
import { INNERTUBE_CLIENTS, buildInnerTubePlayerBody } from './youtube-clients.js';
import { computeSapisidhash, extractVisitorData } from './youtube-auth.js';
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

  it('admits signatureCipher-only formats (v0.11.1 adaptive HD)', () => {
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
    // signatureCipher path is now wired: variant.url = decoded url= and
    // variant.signatureCipher carries the full encoded triple for the
    // downloader to re-decipher on fetch.
    expect(out).toHaveLength(1);
    expect(out[0].variants).toHaveLength(1);
    expect(out[0].variants?.[0].url).toBe('https://example');
    expect(out[0].variants?.[0].signatureCipher).toBe('s=AAA&sp=sig&url=https%3A%2F%2Fexample');
  });

  it('drops signatureCipher formats whose url= is missing', () => {
    const out = buildStreamsFromPlayerResponse({
      videoDetails: { videoId: 'xyz' },
      streamingData: {
        adaptiveFormats: [
          {
            itag: 137,
            // No url= component — unrecoverable.
            signatureCipher: 's=AAA&sp=sig',
            mimeType: 'video/mp4',
            bitrate: 4_500_000,
            width: 1920,
            height: 1080,
          },
        ],
      },
    });
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

  it('prefers audioIsDefault when picking the default paired audio (multi-dub video)', () => {
    // The bug this regression-tests: a video with English (original) +
    // French dub, where the French dub happens to win the bitrate
    // sort. Picking purely by bitrate paired French audio with the
    // English-original video. The fix prefers `audioIsDefault === true`
    // tracks first; bitrate is only the within-default tiebreaker.
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
          {
            itag: 140,
            url: 'https://x/140-en',
            mimeType: 'audio/mp4; codecs="mp4a.40.2"',
            bitrate: 128_000,
            audioTrack: { id: 'en.4', displayName: 'English (original)', audioIsDefault: true },
          },
          {
            itag: 140,
            url: 'https://x/140-fr',
            mimeType: 'audio/mp4; codecs="mp4a.40.2"',
            bitrate: 160_000,
            audioTrack: { id: 'fr.4', displayName: 'French', audioIsDefault: false },
          },
        ],
      },
    });
    const adaptive = out[0].variants?.find((v) => v.url === 'https://x/137');
    // Without the fix this would pair French (higher bitrate); with
    // the fix it pairs English (the audioIsDefault track).
    expect(adaptive?.pairedAudioUrl).toBe('https://x/140-en');
  });

  it('still pairs single-track videos by bitrate (audioTrack absent)', () => {
    // Sanity: when no track is marked default — i.e. a single-track
    // video that doesn't even ship the audioTrack field — the
    // fallback path picks highest-bitrate AAC. Preserves v0.11
    // behavior for the common case.
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
          {
            itag: 139,
            url: 'https://x/139-aac-48',
            mimeType: 'audio/mp4; codecs="mp4a.40.2"',
            bitrate: 48_000,
          },
          {
            itag: 140,
            url: 'https://x/140-aac-128',
            mimeType: 'audio/mp4; codecs="mp4a.40.2"',
            bitrate: 128_000,
          },
        ],
      },
    });
    const adaptive = out[0].variants?.find((v) => v.url === 'https://x/137');
    expect(adaptive?.pairedAudioUrl).toBe('https://x/140-aac-128');
  });

  it('surfaces audioTracks on the DiscoveredStream when video has multiple dubs', () => {
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
          {
            itag: 140,
            url: 'https://x/140-en',
            mimeType: 'audio/mp4; codecs="mp4a.40.2"',
            bitrate: 128_000,
            contentLength: '512000',
            audioTrack: { id: 'en.4', displayName: 'English (original)', audioIsDefault: true },
          },
          {
            itag: 140,
            url: 'https://x/140-fr',
            mimeType: 'audio/mp4; codecs="mp4a.40.2"',
            bitrate: 160_000,
            contentLength: '640000',
            audioTrack: { id: 'fr.4', displayName: 'French', audioIsDefault: false },
          },
        ],
      },
    });
    expect(out[0].audioTracks).toHaveLength(2);
    // Default track sorted first so the popup picker defaults to original.
    expect(out[0].audioTracks?.[0].id).toBe('en.4');
    expect(out[0].audioTracks?.[0].isDefault).toBe(true);
    expect(out[0].audioTracks?.[0].url).toBe('https://x/140-en');
    expect(out[0].audioTracks?.[0].contentLength).toBe(512000);
    expect(out[0].audioTracks?.[1].id).toBe('fr.4');
    expect(out[0].audioTracks?.[1].isDefault).toBe(false);
  });

  it('omits audioTracks on single-track videos (no audioTrack field at all)', () => {
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
          {
            itag: 140,
            url: 'https://x/140',
            mimeType: 'audio/mp4; codecs="mp4a.40.2"',
            bitrate: 128_000,
          },
        ],
      },
    });
    // Single-track videos elide audioTrack entirely — the popup
    // shouldn't render a 1-option picker, so audioTracks stays unset.
    expect(out[0].audioTracks).toBeUndefined();
  });

  it('admits VP9 / AV1 video variants (codec compatibility is enforced at dispatch)', () => {
    // discoverStreams no longer filters by video codec — the picker
    // surfaces the full inventory, and the dispatch + future muxer
    // throw a typed UnsupportedFormatError when the user picks a
    // variant the pipeline can't process. Hiding VP9/AV1 made the
    // picker empty on the majority of current YouTube uploads.
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
    expect(out).toHaveLength(1);
    expect(out[0].variants).toHaveLength(2);
  });
});

describe('buildAudioTracks', () => {
  it('returns undefined when zero AAC formats are present', () => {
    expect(buildAudioTracks([])).toBeUndefined();
  });

  it('returns undefined when a single track is present (no picker needed)', () => {
    expect(
      buildAudioTracks([
        {
          itag: 140,
          url: 'https://x/140',
          mimeType: 'audio/mp4; codecs="mp4a.40.2"',
          bitrate: 128_000,
          audioTrack: { id: 'en.4', displayName: 'English', audioIsDefault: true },
        },
      ]),
    ).toBeUndefined();
  });

  it('picks the highest-bitrate AAC format per track id', () => {
    const out = buildAudioTracks([
      {
        itag: 139,
        url: 'https://x/139-en-low',
        mimeType: 'audio/mp4; codecs="mp4a.40.2"',
        bitrate: 48_000,
        audioTrack: { id: 'en.4', displayName: 'English', audioIsDefault: true },
      },
      {
        itag: 140,
        url: 'https://x/140-en-high',
        mimeType: 'audio/mp4; codecs="mp4a.40.2"',
        bitrate: 128_000,
        audioTrack: { id: 'en.4', displayName: 'English', audioIsDefault: true },
      },
      {
        itag: 140,
        url: 'https://x/140-fr',
        mimeType: 'audio/mp4; codecs="mp4a.40.2"',
        bitrate: 128_000,
        audioTrack: { id: 'fr.4', displayName: 'French', audioIsDefault: false },
      },
    ]);
    expect(out).toHaveLength(2);
    const en = out?.find((t) => t.id === 'en.4');
    expect(en?.url).toBe('https://x/140-en-high');
  });

  it('skips Opus / WebM audio (mux pipeline only handles AAC/m4a today)', () => {
    expect(
      buildAudioTracks([
        {
          itag: 251,
          url: 'https://x/251',
          mimeType: 'audio/webm; codecs="opus"',
          bitrate: 160_000,
          audioTrack: { id: 'en.4', displayName: 'English', audioIsDefault: true },
        },
        {
          itag: 251,
          url: 'https://x/251-fr',
          mimeType: 'audio/webm; codecs="opus"',
          bitrate: 160_000,
          audioTrack: { id: 'fr.4', displayName: 'French', audioIsDefault: false },
        },
      ]),
    ).toBeUndefined();
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

// ---------- v0.11.2 InnerTube client fallback ----------

describe('buildInnerTubePlayerBody', () => {
  it('emits the canonical WEB_CREATOR client shape', () => {
    const wc = INNERTUBE_CLIENTS.find((c) => c.name === 'WEB_CREATOR')!;
    const body = buildInnerTubePlayerBody('dQw4w9WgXcQ', wc) as {
      context: { client: Record<string, string>; thirdParty?: object };
      videoId: string;
      contentCheckOk: boolean;
      racyCheckOk: boolean;
    };
    expect(body.context.client.clientName).toBe('WEB_CREATOR');
    expect(body.context.client.clientVersion).toMatch(/^\d+\.\d+/);
    expect(body.videoId).toBe('dQw4w9WgXcQ');
    expect(body.contentCheckOk).toBe(true);
    expect(body.racyCheckOk).toBe(true);
    // Non-embed clients have no thirdParty.embedUrl.
    expect(body.context.thirdParty).toBeUndefined();
  });

  it('includes thirdParty.embedUrl for TVHTML5_SIMPLY_EMBEDDED_PLAYER', () => {
    const tv = INNERTUBE_CLIENTS.find((c) => c.name === 'TVHTML5_SIMPLY_EMBEDDED_PLAYER')!;
    const body = buildInnerTubePlayerBody('abc', tv) as {
      context: { thirdParty: { embedUrl: string } };
    };
    expect(body.context.thirdParty?.embedUrl).toBe('https://www.youtube.com/');
  });
});

describe('fetchInnerTubePlayer', () => {
  // The vi.spyOn return is typed as a fetch-specific mock; we widen to
  // `any` because the test only cares about `.mockResolvedValue` etc.
  // not the precise generic shape.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: any;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('POSTs to the right URL with the API key from the client config', async () => {
    const wc = INNERTUBE_CLIENTS.find((c) => c.name === 'WEB_CREATOR')!;
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ videoDetails: { videoId: 'abc' } }), { status: 200 }),
    );
    await fetchInnerTubePlayer('abc', wc);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [calledUrl, init] = fetchSpy.mock.calls[0];
    expect(String(calledUrl)).toBe(`https://www.youtube.com/youtubei/v1/player?key=${wc.apiKey}`);
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).credentials).toBe('include');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.videoId).toBe('abc');
    expect(body.context.client.clientName).toBe('WEB_CREATOR');
    // X-YouTube-Client-* headers carry the client name + version for
    // YouTube's server-side routing.
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['X-YouTube-Client-Name']).toBe('WEB_CREATOR');
    expect(headers['X-YouTube-Client-Version']).toBe(wc.context.clientVersion);
  });

  it('returns null on non-200', async () => {
    const wc = INNERTUBE_CLIENTS.find((c) => c.name === 'WEB_CREATOR')!;
    fetchSpy.mockResolvedValue(new Response('forbidden', { status: 403 }));
    expect(await fetchInnerTubePlayer('abc', wc)).toBeNull();
  });

  it('returns null on fetch error', async () => {
    const wc = INNERTUBE_CLIENTS.find((c) => c.name === 'WEB_CREATOR')!;
    fetchSpy.mockRejectedValue(new Error('network down'));
    expect(await fetchInnerTubePlayer('abc', wc)).toBeNull();
  });

  it('returns null on malformed JSON body', async () => {
    const wc = INNERTUBE_CLIENTS.find((c) => c.name === 'WEB_CREATOR')!;
    fetchSpy.mockResolvedValue(new Response('<html>error</html>', { status: 200 }));
    expect(await fetchInnerTubePlayer('abc', wc)).toBeNull();
  });

  it('adds Authorization + X-Origin + X-Goog-Visitor-Id when auth is provided', async () => {
    const wc = INNERTUBE_CLIENTS.find((c) => c.name === 'WEB_CREATOR')!;
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    await fetchInnerTubePlayer('abc', wc, {
      sapisidhash: 'SAPISIDHASH 1700000000_deadbeef',
      visitorData: 'CgtfYWJjMTIzNDU2Nyje3OK',
    });
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('SAPISIDHASH 1700000000_deadbeef');
    expect(headers['X-Origin']).toBe('https://www.youtube.com');
    expect(headers['X-Goog-Visitor-Id']).toBe('CgtfYWJjMTIzNDU2Nyje3OK');
    // visitorData also lands in the body's context.client so server-side
    // checks reading from there pass too.
    const body = JSON.parse(init.body as string);
    expect(body.context.client.visitorData).toBe('CgtfYWJjMTIzNDU2Nyje3OK');
  });

  it('skips the auth headers when auth is empty', async () => {
    const wc = INNERTUBE_CLIENTS.find((c) => c.name === 'WEB_CREATOR')!;
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    await fetchInnerTubePlayer('abc', wc);
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
    expect(headers['X-Origin']).toBeUndefined();
    expect(headers['X-Goog-Visitor-Id']).toBeUndefined();
    const body = JSON.parse(init.body as string);
    expect(body.context.client.visitorData).toBeUndefined();
  });
});

describe('computeSapisidhash', () => {
  it('hashes `${ts} ${SAPISID} ${origin}` with SHA-1 and formats the header', async () => {
    // SAPISID is the canonical cookie name; the helper also accepts
    // the __Secure-3PAPISID and __Secure-1PAPISID variants.
    const out = await computeSapisidhash(
      'foo=bar; SAPISID=ABC123XYZ; baz=qux',
      'https://www.youtube.com',
      1700000000,
    );
    // Expected SHA-1 of `1700000000 ABC123XYZ https://www.youtube.com`
    // computed independently — locks the algorithm down.
    const expected = await sha1Hex(`1700000000 ABC123XYZ https://www.youtube.com`);
    expect(out).toBe(`SAPISIDHASH 1700000000_${expected}`);
  });

  it('falls back to __Secure-3PAPISID when SAPISID is absent', async () => {
    const out = await computeSapisidhash(
      'foo=bar; __Secure-3PAPISID=secureXyz; baz=qux',
      'https://www.youtube.com',
      1700000000,
    );
    const expected = await sha1Hex(`1700000000 secureXyz https://www.youtube.com`);
    expect(out).toBe(`SAPISIDHASH 1700000000_${expected}`);
  });

  it('prefers SAPISID over the __Secure-* aliases when multiple are present', async () => {
    const out = await computeSapisidhash(
      'SAPISID=primary; __Secure-3PAPISID=secondary',
      'https://www.youtube.com',
      1700000000,
    );
    const expected = await sha1Hex(`1700000000 primary https://www.youtube.com`);
    expect(out).toBe(`SAPISIDHASH 1700000000_${expected}`);
  });

  it('returns null when no SAPISID cookie is present', async () => {
    expect(
      await computeSapisidhash('foo=bar; baz=qux', 'https://www.youtube.com', 1700000000),
    ).toBe(null);
    expect(await computeSapisidhash('', 'https://www.youtube.com', 1700000000)).toBe(null);
  });
});

async function sha1Hex(message: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(message));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

describe('extractVisitorData', () => {
  it('reads responseContext.visitorData when present', () => {
    expect(extractVisitorData({ responseContext: { visitorData: 'CgtABC' } })).toBe('CgtABC');
  });
  it('returns null when responseContext is missing', () => {
    expect(extractVisitorData({})).toBeNull();
    expect(extractVisitorData(null)).toBeNull();
    expect(extractVisitorData({ responseContext: {} })).toBeNull();
  });
});

describe('mergeInlineIntoInnerTube', () => {
  const stream = (variants: Array<Record<string, unknown>>) =>
    [{ url: 'youtube:vid', kind: 'dash' as const, variants }] as never;

  it('prefers the inline URL when the same itag exists on both sides', () => {
    // The whole point: inline is the fetchable side, InnerTube's is gated.
    const out = mergeInlineIntoInnerTube(
      stream([
        { url: 'https://gated/701', bandwidth: 9000, itag: 701, resolution: '3840x2160' },
        { url: 'https://gated/18', bandwidth: 500, itag: 18, resolution: '640x360' },
      ]),
      stream([{ url: 'https://works/18', bandwidth: 500, itag: 18, resolution: '640x360' }]),
    );
    const byItag = Object.fromEntries((out[0].variants ?? []).map((v) => [v.itag, v.url]));
    expect(byItag[18]).toBe('https://works/18');
    expect(byItag[701]).toBe('https://gated/701');
  });

  it('keeps the full InnerTube inventory rather than replacing it', () => {
    const out = mergeInlineIntoInnerTube(
      stream([
        { url: 'https://gated/701', bandwidth: 9000, itag: 701 },
        { url: 'https://gated/18', bandwidth: 500, itag: 18 },
      ]),
      stream([{ url: 'https://works/18', bandwidth: 500, itag: 18 }]),
    );
    expect(out[0].variants).toHaveLength(2);
  });

  it('appends an inline-only rendition that InnerTube did not return', () => {
    const out = mergeInlineIntoInnerTube(
      stream([{ url: 'https://gated/701', bandwidth: 9000, itag: 701 }]),
      stream([{ url: 'https://works/18', bandwidth: 500, itag: 18 }]),
    );
    expect(out[0].variants).toHaveLength(2);
    expect((out[0].variants ?? []).some((v) => v.url === 'https://works/18')).toBe(true);
  });

  it('re-sorts merged variants highest-bandwidth first', () => {
    const out = mergeInlineIntoInnerTube(
      stream([{ url: 'https://gated/18', bandwidth: 500, itag: 18 }]),
      stream([{ url: 'https://works/22', bandwidth: 2000, itag: 22 }]),
    );
    expect((out[0].variants ?? []).map((v) => v.bandwidth)).toEqual([2000, 500]);
  });

  it('falls back to resolution + codecs when itag is absent on both sides', () => {
    const out = mergeInlineIntoInnerTube(
      stream([{ url: 'https://gated/a', bandwidth: 500, resolution: '640x360', codecs: 'avc1' }]),
      stream([{ url: 'https://works/a', bandwidth: 500, resolution: '640x360', codecs: 'avc1' }]),
    );
    expect(out[0].variants).toHaveLength(1);
    expect((out[0].variants ?? [])[0].url).toBe('https://works/a');
  });

  it('returns the InnerTube catalog untouched when inline has no variants', () => {
    const it = stream([{ url: 'https://gated/701', bandwidth: 9000, itag: 701 }]);
    expect(mergeInlineIntoInnerTube(it, [] as never)).toBe(it);
  });
});

describe('readVisitorDataFromYtcfg', () => {
  // Tests run in the `node` environment, so stand in the only surface
  // the reader actually touches: a list of scripts with text bodies.
  const docWithScripts = (bodies: string[]): Document =>
    ({
      querySelectorAll: () => bodies.map((textContent) => ({ textContent })),
    }) as unknown as Document;

  it('reads VISITOR_DATA out of the ytcfg bootstrap script', () => {
    const doc = docWithScripts([
      'var x = 1;',
      'ytcfg.set({"INNERTUBE_CLIENT_NAME":"WEB","VISITOR_DATA":"CgtVSVQtVklT","OTHER":1});',
    ]);
    expect(readVisitorDataFromYtcfg(doc)).toBe('CgtVSVQtVklT');
  });

  it('tolerates whitespace around the JSON separator', () => {
    const doc = docWithScripts(['ytcfg.set({"VISITOR_DATA"  :  "CgtWUw"});']);
    expect(readVisitorDataFromYtcfg(doc)).toBe('CgtWUw');
  });

  it('returns null when no script carries the key', () => {
    expect(readVisitorDataFromYtcfg(docWithScripts(['var a = 2;', '{}']))).toBeNull();
  });

  it('returns null for an empty document', () => {
    expect(readVisitorDataFromYtcfg(docWithScripts([]))).toBeNull();
  });
});

// ---------- discoverYouTubeStreams fallback ladder ----------
//
// We mock fetch + construct a minimal fake Document so the inline
// scrape can run without jsdom. The ladder branches we want to lock in:
//   1. Inline has adaptive → InnerTube never called.
//   2. Inline lacks adaptive but has videoId → InnerTube is called.
//   3. InnerTube clients all fail → result falls back to inline.
//   4. InnerTube success on the first client → second client not tried.

function makeFakeDoc(
  scriptBodies: string[],
  title = '',
  opts: { locationHref?: string } = {},
): Document {
  const scripts = scriptBodies.map((text) => ({ textContent: text }));
  const doc = {
    title,
    location: opts.locationHref ? { href: opts.locationHref } : undefined,
    querySelectorAll: (sel: string): { length: number } & Iterable<unknown> => {
      if (sel === 'script') {
        return {
          length: scripts.length,
          [Symbol.iterator]: () => scripts[Symbol.iterator](),
        };
      }
      return {
        length: 0,
        [Symbol.iterator]: () => [][Symbol.iterator](),
      };
    },
    querySelector: () => null,
  };
  return doc as unknown as Document;
}

describe('discoverYouTubeStreams', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: any;

  beforeEach(() => {
    _clearInnerTubeCacheForTests();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('uses inline when inline has an adaptive variant (no InnerTube call)', async () => {
    // Inline player response with one adaptive video + one AAC audio.
    // buildStreamsFromPlayerResponse will pair them, producing an
    // adaptive variant — that's enough to skip the InnerTube ladder.
    const inline = {
      videoDetails: { videoId: 'inline-vid' },
      playabilityStatus: { status: 'OK' },
      streamingData: {
        adaptiveFormats: [
          {
            itag: 137,
            url: 'https://video.example/137',
            mimeType: 'video/mp4; codecs="avc1.640028"',
            bitrate: 4_500_000,
            width: 1920,
            height: 1080,
          },
          {
            itag: 140,
            url: 'https://audio.example/140',
            mimeType: 'audio/mp4; codecs="mp4a.40.2"',
            bitrate: 128_000,
          },
        ],
      },
    };
    const doc = makeFakeDoc([`var ytInitialPlayerResponse = ${JSON.stringify(inline)};`]);
    const streams = await discoverYouTubeStreams(doc);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(streams).toHaveLength(1);
    expect(streams[0].variants?.some((v) => !!v.pairedAudioUrl)).toBe(true);
  });

  it('falls through to InnerTube when inline has no adaptive variants', async () => {
    // SABR-shaped inline: metadata only, no URLs on adaptive.
    const inline = {
      videoDetails: { videoId: 'sabr-vid' },
      playabilityStatus: { status: 'OK' },
      streamingData: {
        formats: [
          {
            itag: 18,
            url: 'https://video.example/18',
            mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"',
            bitrate: 500_000,
            width: 640,
            height: 360,
          },
        ],
        adaptiveFormats: [
          {
            itag: 137,
            mimeType: 'video/mp4; codecs="avc1.640028"',
            bitrate: 4_500_000,
            width: 1920,
            height: 1080,
            // no url / no signatureCipher / no cipher — SABR
          },
        ],
      },
    };
    // InnerTube response: full URLs flow.
    const innerTube = {
      videoDetails: { videoId: 'sabr-vid' },
      playabilityStatus: { status: 'OK' },
      streamingData: {
        adaptiveFormats: [
          {
            itag: 137,
            url: 'https://innertube.example/137',
            mimeType: 'video/mp4; codecs="avc1.640028"',
            bitrate: 4_500_000,
            width: 1920,
            height: 1080,
          },
          {
            itag: 140,
            url: 'https://innertube.example/140',
            mimeType: 'audio/mp4; codecs="mp4a.40.2"',
            bitrate: 128_000,
          },
        ],
      },
    };
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify(innerTube), { status: 200 }));
    const doc = makeFakeDoc([`var ytInitialPlayerResponse = ${JSON.stringify(inline)};`]);
    const streams = await discoverYouTubeStreams(doc);
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(streams[0].variants?.[0].url).toBe('https://innertube.example/137');
    expect(streams[0].variants?.some((v) => !!v.pairedAudioUrl)).toBe(true);
  });

  it('falls back to inline when every InnerTube client returns no adaptive', async () => {
    // Inline: SABR-shaped (no adaptive URLs).
    const inline = {
      videoDetails: { videoId: 'all-fail' },
      playabilityStatus: { status: 'OK' },
      streamingData: {
        formats: [
          {
            itag: 18,
            url: 'https://video.example/18',
            mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"',
            bitrate: 500_000,
            width: 640,
            height: 360,
          },
        ],
        adaptiveFormats: [],
      },
    };
    // Every InnerTube client also returns empty adaptive — non-200
    // responses count as "no adaptive" for the ladder.
    fetchSpy.mockResolvedValue(new Response('nope', { status: 403 }));
    const doc = makeFakeDoc([`var ytInitialPlayerResponse = ${JSON.stringify(inline)};`]);
    const streams = await discoverYouTubeStreams(doc);
    // Both clients were attempted, then we fell back to inline.
    expect(fetchSpy).toHaveBeenCalledTimes(INNERTUBE_CLIENTS.length);
    // Inline progressive itag=18 still surfaces.
    expect(streams[0].variants?.some((v) => v.url.includes('/18'))).toBe(true);
  });

  it('stops at the first InnerTube client that returns adaptive', async () => {
    const inline = {
      videoDetails: { videoId: 'first-wins' },
      playabilityStatus: { status: 'OK' },
      streamingData: { adaptiveFormats: [] },
    };
    const success = {
      videoDetails: { videoId: 'first-wins' },
      playabilityStatus: { status: 'OK' },
      streamingData: {
        adaptiveFormats: [
          {
            itag: 137,
            url: 'https://innertube.example/137',
            mimeType: 'video/mp4; codecs="avc1.640028"',
            bitrate: 4_500_000,
            width: 1920,
            height: 1080,
          },
          {
            itag: 140,
            url: 'https://innertube.example/140',
            mimeType: 'audio/mp4; codecs="mp4a.40.2"',
            bitrate: 128_000,
          },
        ],
      },
    };
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify(success), { status: 200 }));
    const doc = makeFakeDoc([`var ytInitialPlayerResponse = ${JSON.stringify(inline)};`]);
    await discoverYouTubeStreams(doc);
    // First client succeeded → no second call.
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('SPA-nav: treats inline as stale when URL videoId differs from inline videoId', async () => {
    // Reproduces the field report: user navigates to /watch?v=NEW
    // but YouTube doesn't rewrite the inline ytInitialPlayerResponse
    // script tag — it still carries OLD's data. Pre-fix discoverStreams
    // would happily return OLD's variants (and the SW would dedupe
    // against the existing OLD entry, so the popup never updated).
    // Post-fix: detect the videoId mismatch, skip inline, fetch
    // InnerTube for the URL videoId.
    const stale = {
      videoDetails: { videoId: 'old-vid' },
      playabilityStatus: { status: 'OK' },
      streamingData: {
        adaptiveFormats: [
          {
            itag: 137,
            url: 'https://video.example/OLD-137',
            mimeType: 'video/mp4; codecs="avc1.640028"',
            bitrate: 4_500_000,
            width: 1920,
            height: 1080,
          },
          {
            itag: 140,
            url: 'https://audio.example/OLD-140',
            mimeType: 'audio/mp4; codecs="mp4a.40.2"',
            bitrate: 128_000,
          },
        ],
      },
    };
    const innertubeForNew = {
      videoDetails: { videoId: 'new-vid' },
      playabilityStatus: { status: 'OK' },
      streamingData: {
        adaptiveFormats: [
          {
            itag: 137,
            url: 'https://video.example/NEW-137',
            mimeType: 'video/mp4; codecs="avc1.640028"',
            bitrate: 4_500_000,
            width: 1920,
            height: 1080,
          },
          {
            itag: 140,
            url: 'https://audio.example/NEW-140',
            mimeType: 'audio/mp4; codecs="mp4a.40.2"',
            bitrate: 128_000,
          },
        ],
      },
    };
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify(innertubeForNew), { status: 200 }));
    const doc = makeFakeDoc([`var ytInitialPlayerResponse = ${JSON.stringify(stale)};`], '', {
      locationHref: 'https://www.youtube.com/watch?v=new-vid',
    });
    const streams = await discoverYouTubeStreams(doc);
    expect(fetchSpy).toHaveBeenCalled();
    expect(streams[0].url).toBe('youtube:new-vid');
    // Variants must come from the InnerTube response, not the stale inline blob.
    expect(streams[0].variants?.[0].url).toBe('https://video.example/NEW-137');
  });
});

describe('extractVideoIdFromUrl', () => {
  it('reads ?v= for /watch URLs', async () => {
    const { extractVideoIdFromUrl } = await import('./youtube.js');
    expect(extractVideoIdFromUrl('https://www.youtube.com/watch?v=abc123')).toBe('abc123');
  });

  it('reads the path segment for /shorts /embed /live', async () => {
    const { extractVideoIdFromUrl } = await import('./youtube.js');
    expect(extractVideoIdFromUrl('https://www.youtube.com/shorts/abc123')).toBe('abc123');
    expect(extractVideoIdFromUrl('https://www.youtube.com/embed/abc123')).toBe('abc123');
    expect(extractVideoIdFromUrl('https://www.youtube.com/live/abc123')).toBe('abc123');
  });

  it('reads the path for youtu.be short links', async () => {
    const { extractVideoIdFromUrl } = await import('./youtube.js');
    expect(extractVideoIdFromUrl('https://youtu.be/abc123')).toBe('abc123');
    expect(extractVideoIdFromUrl('https://youtu.be/abc123?t=10')).toBe('abc123');
  });

  it('returns null for non-video YouTube URLs', async () => {
    const { extractVideoIdFromUrl } = await import('./youtube.js');
    expect(extractVideoIdFromUrl('https://www.youtube.com/')).toBeNull();
    expect(extractVideoIdFromUrl('https://www.youtube.com/results?search_query=test')).toBeNull();
  });

  it('returns null for malformed URLs', async () => {
    const { extractVideoIdFromUrl } = await import('./youtube.js');
    expect(extractVideoIdFromUrl('not-a-url')).toBeNull();
    expect(extractVideoIdFromUrl('')).toBeNull();
  });
});
