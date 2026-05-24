import { describe, it, expect } from 'vitest';

import {
  filterDownloadableVariants,
  formatAudioTrack,
  formatVariant,
  hasAudioTrackPicker,
  isVariantDownloadable,
  pickDefaultAudioTrackId,
  pickDisplayVariantUrl,
  pickDownloadVariantUrl,
} from './popup-helpers.js';
import type { AudioTrack, DownloadState, HlsVariant, MediaEntry } from '../lib/types.ts';

// ---------- fixtures ----------

function variant(over: Partial<HlsVariant> & { url: string }): HlsVariant {
  return {
    url: over.url,
    bandwidth: over.bandwidth ?? 0,
    resolution: over.resolution ?? null,
    codecs: over.codecs ?? null,
    ...(over.contentLength != null ? { contentLength: over.contentLength } : {}),
    ...(over.pairedAudioUrl ? { pairedAudioUrl: over.pairedAudioUrl } : {}),
    ...(over.pairedAudioContentLength != null
      ? { pairedAudioContentLength: over.pairedAudioContentLength }
      : {}),
    ...(over.signatureCipher ? { signatureCipher: over.signatureCipher } : {}),
    ...(over.pairedSignatureCipher ? { pairedSignatureCipher: over.pairedSignatureCipher } : {}),
  };
}

function hotmartHlsVariant(quality: '1080p' | '720p' | '480p'): HlsVariant {
  const bw = quality === '1080p' ? 3_241_000 : quality === '720p' ? 1_280_000 : 640_000;
  const h = quality === '1080p' ? 1080 : quality === '720p' ? 720 : 480;
  return variant({
    url: `https://vod-akm.play.hotmart.com/video/abc/${quality}/playlist.m3u8`,
    bandwidth: bw,
    resolution: `${Math.round((h * 16) / 9)}x${h}`,
    codecs: 'avc1.640028,mp4a.40.2',
  });
}

// googlevideo URLs need `mime=` for classifyUrl to recognize the
// adaptive (dash) vs progressive split — without it, classifyUrl
// returns null and `isVariantDownloadable` then short-circuits to
// "treat as non-dash → always downloadable", which is the wrong
// answer for VP9/AV1 fixtures.
function ytAvcAdaptiveVariant(quality: '1080p' | '720p'): HlsVariant {
  const bw = quality === '1080p' ? 4_500_000 : 1_500_000;
  const h = quality === '1080p' ? 1080 : 720;
  return variant({
    url: `https://r1.googlevideo.com/videoplayback?itag=137&mime=video%2Fmp4&q=${quality}`,
    bandwidth: bw,
    resolution: `${Math.round((h * 16) / 9)}x${h}`,
    codecs: 'avc1.640028',
    pairedAudioUrl: 'https://r1.googlevideo.com/videoplayback?itag=140&mime=audio%2Fmp4',
    contentLength: bw * 60,
  });
}

function ytVp9Variant(quality: '1080p' | '720p'): HlsVariant {
  const bw = quality === '1080p' ? 3_000_000 : 1_000_000;
  const h = quality === '1080p' ? 1080 : 720;
  return variant({
    url: `https://r1.googlevideo.com/videoplayback?itag=248&mime=video%2Fwebm&q=${quality}`,
    bandwidth: bw,
    resolution: `${Math.round((h * 16) / 9)}x${h}`,
    codecs: 'vp09.00.50.08',
    pairedAudioUrl: 'https://r1.googlevideo.com/videoplayback?itag=140&mime=audio%2Fmp4',
  });
}

function ytProgressive360pVariant(): HlsVariant {
  return variant({
    url: 'https://r1.googlevideo.com/videoplayback?itag=18&mime=video%2Fmp4',
    bandwidth: 500_000,
    resolution: '640x360',
    codecs: 'avc1.42001E,mp4a.40.2',
  });
}

function entry(over: Partial<MediaEntry> & { id: string }): MediaEntry {
  return {
    id: over.id,
    kind: over.kind ?? 'hls',
    url: over.url ?? `https://example.com/master.m3u8`,
    pageUrl: over.pageUrl ?? 'https://example.com/',
    adapterId: over.adapterId ?? 'hotmart',
    capturedAt: over.capturedAt ?? 0,
    ...(over.variants ? { variants: over.variants } : {}),
    ...(over.isMaster != null ? { isMaster: over.isMaster } : {}),
    ...(over.totalDuration != null ? { totalDuration: over.totalDuration } : {}),
    ...(over.parseError != null ? { parseError: over.parseError } : {}),
    ...(over.audioTracks ? { audioTracks: over.audioTracks } : {}),
  };
}

function audioTrack(over: Partial<AudioTrack> & { id: string }): AudioTrack {
  return {
    id: over.id,
    displayName: over.displayName ?? over.id,
    isDefault: over.isDefault ?? false,
    url: over.url ?? `https://r1.googlevideo.com/audio?track=${over.id}`,
    ...(over.contentLength != null ? { contentLength: over.contentLength } : {}),
    ...(over.signatureCipher ? { signatureCipher: over.signatureCipher } : {}),
  };
}

function downloadState(over: Partial<DownloadState> & { mediaId: string }): DownloadState {
  return {
    requestId: over.requestId ?? 'req-1',
    mediaId: over.mediaId,
    tabId: over.tabId ?? 1,
    filename: over.filename ?? 'video.mp4',
    status: over.status ?? 'progress',
    stage: over.stage ?? 'fetch',
    current: over.current ?? 0,
    total: over.total ?? 100,
    startedAt: over.startedAt ?? 0,
    ...(over.variantUrl ? { variantUrl: over.variantUrl } : {}),
    ...(over.audioTrackId ? { audioTrackId: over.audioTrackId } : {}),
  };
}

// ---------- isVariantDownloadable ----------

describe('isVariantDownloadable', () => {
  it('admits Hotmart HLS variants of any codec', () => {
    expect(isVariantDownloadable(hotmartHlsVariant('1080p'))).toBe(true);
    expect(isVariantDownloadable(hotmartHlsVariant('720p'))).toBe(true);
  });

  it('admits YouTube progressive (single-stream) variants', () => {
    expect(isVariantDownloadable(ytProgressive360pVariant())).toBe(true);
  });

  it('admits YouTube adaptive AVC variants when paired with audio', () => {
    expect(isVariantDownloadable(ytAvcAdaptiveVariant('1080p'))).toBe(true);
    expect(isVariantDownloadable(ytAvcAdaptiveVariant('720p'))).toBe(true);
  });

  it('rejects VP9 adaptive variants — stream-copy muxer is mp4-only', () => {
    expect(isVariantDownloadable(ytVp9Variant('1080p'))).toBe(false);
    expect(isVariantDownloadable(ytVp9Variant('720p'))).toBe(false);
  });

  it('admits AV1 adaptive variants (v0.11.5 — fMP4 same shape as AVC)', () => {
    // YouTube serves AV1 inside the same ISOBMFF box layout as AVC;
    // the sample entry inside trak.mdia.minf.stbl.stsd is the only
    // thing that differs (`av01` vs `avc1`) and combineFmp4 copies
    // the trak subtree verbatim. So once we lift the codec filter
    // here, the existing muxer handles AV1 with no further changes.
    const av1 = variant({
      url: 'https://r1.googlevideo.com/videoplayback?itag=399&mime=video%2Fmp4',
      bandwidth: 2_000_000,
      resolution: '1920x1080',
      codecs: 'av01.0.05M.08',
      pairedAudioUrl: 'https://r1.googlevideo.com/videoplayback?itag=140&mime=audio%2Fmp4',
    });
    expect(isVariantDownloadable(av1)).toBe(true);
  });

  it('admits AV1 4K variants — the actual reason for the codec lift', () => {
    // YouTube caps AVC at 1080p; 1440p / 2160p exist only as AV1
    // (in fMP4) or VP9 (in WebM, see Phase C). This is the test
    // case the field cares about.
    const av1_4k = variant({
      url: 'https://r1.googlevideo.com/videoplayback?itag=571&mime=video%2Fmp4',
      bandwidth: 12_000_000,
      resolution: '3840x2160',
      codecs: 'av01.0.13M.08',
      pairedAudioUrl: 'https://r1.googlevideo.com/videoplayback?itag=140&mime=audio%2Fmp4',
    });
    expect(isVariantDownloadable(av1_4k)).toBe(true);
  });

  it('rejects adaptive variants without a paired audio stream', () => {
    const orphan = variant({
      url: 'https://r1.googlevideo.com/videoplayback?itag=137&mime=video%2Fmp4',
      codecs: 'avc1.640028',
      // no pairedAudioUrl
    });
    expect(isVariantDownloadable(orphan)).toBe(false);
  });

  it('admits adaptive variants with paired audio when codec metadata is missing', () => {
    // Some YouTube responses elide codecs. We assume muxable rather
    // than hiding the variant entirely.
    const noCodec = variant({
      url: 'https://r1.googlevideo.com/videoplayback?itag=137&mime=video%2Fmp4',
      pairedAudioUrl: 'https://r1.googlevideo.com/videoplayback?itag=140&mime=audio%2Fmp4',
    });
    expect(isVariantDownloadable(noCodec)).toBe(true);
  });
});

// ---------- filterDownloadableVariants ----------

describe('filterDownloadableVariants', () => {
  it('drops VP9 variants but admits AVC + AV1 from a mixed-codec YouTube inventory', () => {
    const av1Variant = variant({
      url: 'https://r1.googlevideo.com/videoplayback?itag=399&mime=video%2Fmp4&q=1080p',
      bandwidth: 2_500_000,
      resolution: '1920x1080',
      codecs: 'av01.0.08M.08',
      pairedAudioUrl: 'https://r1.googlevideo.com/videoplayback?itag=140&mime=audio%2Fmp4',
    });
    const all = [
      ytAvcAdaptiveVariant('1080p'),
      ytVp9Variant('1080p'),
      av1Variant,
      ytAvcAdaptiveVariant('720p'),
      ytVp9Variant('720p'),
      ytProgressive360pVariant(),
    ];
    const filtered = filterDownloadableVariants(all);
    expect(filtered.map((v) => v.url)).toEqual([
      all[0].url, // 1080p AVC
      all[2].url, // 1080p AV1
      all[3].url, // 720p AVC
      all[5].url, // 360p progressive
    ]);
  });

  it('preserves all Hotmart variants — they ride the HLS path which is always muxable', () => {
    const all = [hotmartHlsVariant('1080p'), hotmartHlsVariant('720p'), hotmartHlsVariant('480p')];
    expect(filterDownloadableVariants(all)).toEqual(all);
  });

  it('returns an empty array when every variant is VP9-only (unsupported until Phase C)', () => {
    // Video that only ships VP9 at this resolution — the popup
    // would render a "No supported variants" placeholder option.
    // Once Phase C adds WebM container support this fixture will
    // need updating; until then VP9 is the unsupported codec.
    expect(filterDownloadableVariants([ytVp9Variant('1080p'), ytVp9Variant('720p')])).toEqual([]);
  });
});

// ---------- pickDisplayVariantUrl ----------
//
// This is the helper that fixed the v0.11.3 "quality picker switches
// back to 1080p" regression. Before the fix, the size/duration badges
// always derived from `entry.variants[0]` (the highest-bandwidth
// variant), so when the dropdown was replaced by the in-progress UI
// the badge visually reverted from the picked quality to 1080p — and
// users reasonably read that as "the download started at 1080p
// regardless of what I picked." The fix: when a downloadState carries
// a `variantUrl`, the badge pins to that URL.

describe('pickDisplayVariantUrl', () => {
  const variants = [
    hotmartHlsVariant('1080p'),
    hotmartHlsVariant('720p'),
    hotmartHlsVariant('480p'),
  ];
  const masterEntry = entry({
    id: 'e1',
    isMaster: true,
    variants,
  });

  it('returns the in-flight download variantUrl when present', () => {
    // The user picked 720p and clicked Download — the SW recorded
    // 720p as the variantUrl in the seeded state. Badges must pin
    // to 720p, not the highest (1080p) variant.
    const dlState = downloadState({ mediaId: 'e1', variantUrl: variants[1].url });
    expect(pickDisplayVariantUrl(masterEntry, dlState)).toBe(variants[1].url);
  });

  it('falls back to variants[0] when no download is in flight', () => {
    expect(pickDisplayVariantUrl(masterEntry, null)).toBe(variants[0].url);
    expect(pickDisplayVariantUrl(masterEntry, undefined)).toBe(variants[0].url);
  });

  it('uses the entry URL directly when the entry is a single-bitrate media playlist', () => {
    const mediaEntry = entry({
      id: 'e2',
      isMaster: false,
      url: 'https://example.com/media.m3u8',
    });
    expect(pickDisplayVariantUrl(mediaEntry, null)).toBe('https://example.com/media.m3u8');
  });

  it('falls back to entry.url when the master has no parsed variants yet', () => {
    const unparsed = entry({
      id: 'e3',
      isMaster: true,
      url: 'https://example.com/master.m3u8',
      // no variants
    });
    expect(pickDisplayVariantUrl(unparsed, null)).toBe('https://example.com/master.m3u8');
  });

  it('downloadState.variantUrl wins even when entry.isMaster is false', () => {
    // Defensive: a single-bitrate entry shouldn't have a different
    // variantUrl from its own URL, but if some adapter put a different
    // one in the state (e.g., YouTube progressive with the synthetic
    // identity URL on the entry but the real google URL on the state),
    // the state's value is the right one to trust for the badges.
    const mediaEntry = entry({
      id: 'e2',
      isMaster: false,
      url: 'youtube:abc',
    });
    const dlState = downloadState({
      mediaId: 'e2',
      variantUrl: 'https://r1.googlevideo.com/videoplayback?itag=18',
    });
    expect(pickDisplayVariantUrl(mediaEntry, dlState)).toBe(
      'https://r1.googlevideo.com/videoplayback?itag=18',
    );
  });
});

// ---------- pickDownloadVariantUrl ----------

describe('pickDownloadVariantUrl', () => {
  const variants = [
    hotmartHlsVariant('1080p'),
    hotmartHlsVariant('720p'),
    hotmartHlsVariant('480p'),
  ];
  const masterEntry = entry({
    id: 'e1',
    isMaster: true,
    variants,
  });
  const mediaEntry = entry({
    id: 'e2',
    isMaster: false,
    url: 'https://example.com/media.m3u8',
  });

  it('returns the dropdown value when it is a real URL', () => {
    // This is the load-bearing case for the user's regression report.
    // The dropdown's value at click time MUST be what gets sent.
    expect(pickDownloadVariantUrl(masterEntry, variants[1].url)).toBe(variants[1].url);
    expect(pickDownloadVariantUrl(masterEntry, variants[2].url)).toBe(variants[2].url);
  });

  it('falls back to entry.url for single-bitrate entries when no dropdown value', () => {
    expect(pickDownloadVariantUrl(mediaEntry, undefined)).toBe(mediaEntry.url);
    expect(pickDownloadVariantUrl(mediaEntry, 'single')).toBe(mediaEntry.url);
    expect(pickDownloadVariantUrl(mediaEntry, 'auto')).toBe(mediaEntry.url);
  });

  it('returns null when a master has no real-URL dropdown value (race / not ready)', () => {
    expect(pickDownloadVariantUrl(masterEntry, undefined)).toBeNull();
    // Sentinels from qualityOptionsHtml's placeholders.
    expect(pickDownloadVariantUrl(masterEntry, 'auto')).toBeNull();
    expect(pickDownloadVariantUrl(masterEntry, 'none')).toBeNull();
  });

  it('rejects non-http dropdown values even on a single-bitrate entry — uses entry.url', () => {
    // Defensive: if some future placeholder leaks into the value the
    // single-bitrate fallback should still produce the entry's
    // actual playable URL rather than the sentinel.
    expect(pickDownloadVariantUrl(mediaEntry, 'placeholder-not-a-url')).toBe(mediaEntry.url);
  });
});

// ---------- formatVariant ----------

describe('formatVariant', () => {
  it('formats height + bandwidth when both present', () => {
    expect(formatVariant(hotmartHlsVariant('1080p'))).toBe('1080p (3241 kbps)');
  });

  it('returns just resolution if bandwidth is missing', () => {
    const v = variant({
      url: 'https://example.com/v',
      resolution: '1280x720',
      bandwidth: 0,
    });
    expect(formatVariant(v)).toBe('720p');
  });

  it('returns just kbps if resolution is missing', () => {
    const v = variant({
      url: 'https://example.com/v',
      resolution: null,
      bandwidth: 96_000,
    });
    expect(formatVariant(v)).toBe('96 kbps');
  });

  it('falls back to "variant" when nothing is known', () => {
    const v = variant({
      url: 'https://example.com/v',
      resolution: null,
      bandwidth: 0,
    });
    expect(formatVariant(v)).toBe('variant');
  });

  it('passes resolution through unchanged when it does not contain WxH', () => {
    const v = variant({
      url: 'https://example.com/v',
      resolution: 'auto',
      bandwidth: 0,
    });
    expect(formatVariant(v)).toBe('auto');
  });
});

// ---------- hasAudioTrackPicker ----------

describe('hasAudioTrackPicker', () => {
  it('false when audioTracks is missing', () => {
    expect(hasAudioTrackPicker(entry({ id: 'e' }))).toBe(false);
  });

  it('false with one track (picker would be a 1-option no-op)', () => {
    const e = entry({
      id: 'e',
      audioTracks: [audioTrack({ id: 'en.4', isDefault: true })],
    });
    expect(hasAudioTrackPicker(e)).toBe(false);
  });

  it('true with two or more tracks', () => {
    const e = entry({
      id: 'e',
      audioTracks: [
        audioTrack({ id: 'en.4', isDefault: true }),
        audioTrack({ id: 'fr.4', isDefault: false }),
      ],
    });
    expect(hasAudioTrackPicker(e)).toBe(true);
  });
});

// ---------- pickDefaultAudioTrackId ----------

describe('pickDefaultAudioTrackId', () => {
  it('returns null when entry has no tracks', () => {
    expect(pickDefaultAudioTrackId(entry({ id: 'e' }), null)).toBeNull();
  });

  it('picks the track marked isDefault', () => {
    const e = entry({
      id: 'e',
      audioTracks: [
        audioTrack({ id: 'fr.4', isDefault: false }),
        audioTrack({ id: 'en.4', isDefault: true }),
      ],
    });
    expect(pickDefaultAudioTrackId(e, null)).toBe('en.4');
  });

  it('falls back to the first track when none is default', () => {
    const e = entry({
      id: 'e',
      audioTracks: [
        audioTrack({ id: 'fr.4', isDefault: false }),
        audioTrack({ id: 'de.4', isDefault: false }),
      ],
    });
    expect(pickDefaultAudioTrackId(e, null)).toBe('fr.4');
  });

  it('pins to the download state track when one is in flight', () => {
    // After a download starts the dropdown is replaced by the
    // in-progress UI; if we re-derive the default later (e.g. on
    // re-render) we want the picker to stay on the user's chosen
    // track, not silently revert to the isDefault track.
    const e = entry({
      id: 'e',
      audioTracks: [
        audioTrack({ id: 'en.4', isDefault: true }),
        audioTrack({ id: 'fr.4', isDefault: false }),
      ],
    });
    const ds = downloadState({ mediaId: 'e', audioTrackId: 'fr.4' });
    expect(pickDefaultAudioTrackId(e, ds)).toBe('fr.4');
  });
});

// ---------- formatAudioTrack ----------

describe('formatAudioTrack', () => {
  it('appends "(original)" for the default track', () => {
    expect(
      formatAudioTrack(audioTrack({ id: 'en.4', displayName: 'English', isDefault: true })),
    ).toBe('English (original)');
  });

  it('returns the displayName verbatim for non-default tracks', () => {
    expect(
      formatAudioTrack(audioTrack({ id: 'fr.4', displayName: 'French', isDefault: false })),
    ).toBe('French');
  });
});
