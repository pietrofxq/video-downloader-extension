import { describe, it, expect } from 'vitest';
import { parseManifest } from './m3u8.js';

const MASTER = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=3241000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"
1080p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"
720p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=640000,RESOLUTION=640x360,CODECS="avc1.42c01e,mp4a.40.2"
480p.m3u8
`;

const MEDIA = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:6.0,
seg0.ts
#EXTINF:6.0,
seg1.ts
#EXTINF:5.4,
seg2.ts
#EXT-X-ENDLIST
`;

describe('parseManifest', () => {
  it('detects a master playlist and lists variants sorted by bandwidth', () => {
    const r = parseManifest(MASTER, 'https://x.com/stream/master.m3u8');
    expect(r.isMaster).toBe(true);
    expect(r.variants).toHaveLength(3);
    expect(r.variants[0].bandwidth).toBe(3241000); // highest first
    expect(r.variants[0].resolution).toBe('1920x1080');
    expect(r.variants[2].bandwidth).toBe(640000);
  });

  it('resolves relative variant URIs against the manifest URL', () => {
    const r = parseManifest(MASTER, 'https://x.com/stream/master.m3u8');
    expect(r.variants[0].url).toBe('https://x.com/stream/1080p.m3u8');
  });

  it('keeps absolute URIs untouched', () => {
    const m = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=640x360
https://cdn.example/abs.m3u8
`;
    const r = parseManifest(m, 'https://x.com/master.m3u8');
    expect(r.variants[0].url).toBe('https://cdn.example/abs.m3u8');
  });

  it('detects a media playlist and reports segment count', () => {
    const r = parseManifest(MEDIA, 'https://x.com/stream/media.m3u8');
    expect(r.isMaster).toBe(false);
    expect(r.variants).toEqual([]);
    expect(r.segmentCount).toBe(3);
  });

  it('captures codecs string when present', () => {
    const r = parseManifest(MASTER, 'https://x.com/master.m3u8');
    expect(r.variants[0].codecs).toBe('avc1.640028,mp4a.40.2');
  });

  it('returns empty state for garbage input', () => {
    const r = parseManifest('not a manifest', 'https://x.com/master.m3u8');
    expect(r.isMaster).toBe(false);
    expect(r.variants).toEqual([]);
  });

  it('handles a master without RESOLUTION attribute', () => {
    const m = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000
audio.m3u8
`;
    const r = parseManifest(m, 'https://x.com/master.m3u8');
    expect(r.isMaster).toBe(true);
    expect(r.variants[0].resolution).toBeNull();
    expect(r.variants[0].bandwidth).toBe(800000);
  });

  it('extracts alternates from mediaGroups (#EXT-X-MEDIA)', () => {
    const m = `#EXTM3U
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="pt-BR",LANGUAGE="pt-BR",DEFAULT=NO,AUTOSELECT=YES,URI="subs/pt-br.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="default",LANGUAGE="pt",DEFAULT=YES,AUTOSELECT=YES,URI="audio/aac.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720,AUDIO="aac",SUBTITLES="subs"
720p.m3u8
`;
    const r = parseManifest(m, 'https://x.com/master.m3u8');
    expect(r.isMaster).toBe(true);
    expect(r.variants).toHaveLength(1);
    expect(r.alternates).toHaveLength(2);
    const subs = r.alternates.find((a) => a.type === 'SUBTITLES');
    expect(subs.url).toBe('https://x.com/subs/pt-br.m3u8');
    expect(subs.language).toBe('pt-BR');
    const audio = r.alternates.find((a) => a.type === 'AUDIO');
    expect(audio.url).toBe('https://x.com/audio/aac.m3u8');
    expect(audio.default).toBe(true);
  });

  it('returns empty alternates for a media playlist', () => {
    const r = parseManifest(MEDIA, 'https://x.com/media.m3u8');
    expect(r.alternates).toEqual([]);
  });
});
