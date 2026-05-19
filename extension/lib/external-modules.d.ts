// Ambient declarations for runtime deps that ship without TypeScript
// types. Kept minimal — only the surface the extension actually uses.

declare module 'm3u8-parser' {
  // m3u8-parser's manifest is a free-form bag the parser fills out as
  // it reads tags. We type the fields the extension reads; the rest
  // remains `unknown` so direct access still type-checks via narrowing.
  export interface M3u8Segment {
    uri?: string;
    duration?: number;
    timeline?: number;
    key?: {
      method?: string;
      uri?: string;
      iv?: Uint32Array;
    };
  }
  export interface M3u8Playlist {
    uri?: string;
    attributes?: {
      BANDWIDTH?: number;
      RESOLUTION?: { width?: number; height?: number };
      CODECS?: string;
    };
  }
  export interface M3u8Rendition {
    uri?: string;
    language?: string;
    default?: boolean;
  }
  export interface M3u8Manifest {
    playlists?: M3u8Playlist[];
    segments?: M3u8Segment[];
    mediaSequence?: number;
    mediaGroups?: Record<string, Record<string, Record<string, M3u8Rendition>>>;
  }
  export class Parser {
    manifest: M3u8Manifest;
    push(text: string): void;
    end(): void;
  }
}

declare module 'mux.js' {
  // mux.js doesn't ship types. The Transmuxer surface we use:
  interface MuxSegmentData {
    initSegment?: Uint8Array;
    data?: Uint8Array;
  }
  type MuxEvent = 'data' | 'done';
  export interface Transmuxer {
    on(event: MuxEvent, cb: (segment: MuxSegmentData) => void): void;
    push(bytes: Uint8Array): void;
    flush(): void;
    setBaseMediaDecodeTime(t: number): void;
  }
  interface MuxJs {
    mp4: {
      Transmuxer: new (options?: {
        remux?: boolean;
        keepOriginalTimestamps?: boolean;
      }) => Transmuxer;
    };
  }
  const muxjs: MuxJs;
  export default muxjs;
}
