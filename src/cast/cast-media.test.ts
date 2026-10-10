import type { PlaybackTrack } from '@/playback/types';

import {
  buildCastItems,
  castBlockReason,
  castContentType,
  castNeedsTranscode,
  castTrackIndex,
  isReachableByReceiver,
  isUnaskedJump,
  itemStartingAt,
  trackFilePath,
} from './cast-media';
import type { CastMediaStatus } from './types';

const BOOK = { connectionId: 'srv.3', libraryId: 2, path: 'Author/Book' };

function track(path: string, duration?: number): PlaybackTrack {
  return {
    id: `2:${path}`,
    url: `https://h/api/v1/libraries/2/stream?path=${encodeURIComponent(path)}&token=SESSION`,
    title: 'Book',
    album: 'Series',
    artist: 'Author',
    duration,
  };
}

/** The URL builders of a client carrying the cast token. */
const urls = {
  streamUrl: (lib: number, path: string, _d?: boolean, o?: { transcode?: boolean }) =>
    `https://h/api/v1/libraries/${lib}/stream?path=${encodeURIComponent(path)}${o?.transcode ? '&transcode=1' : ''}&token=CAST`,
  coverUrl: (lib: number, path: string) =>
    `https://h/api/v1/libraries/${lib}/cover?path=${encodeURIComponent(path)}&token=CAST`,
};

describe('castNeedsTranscode', () => {
  it('follows the server (direct_playable false) and the codecs the receiver cannot play', () => {
    expect(castNeedsTranscode({ codec: 'aac', direct_playable: true })).toBe(false);
    expect(castNeedsTranscode({ codec: 'mp3' })).toBe(false);
    expect(castNeedsTranscode({ codec: 'aac', direct_playable: false })).toBe(true);
    expect(castNeedsTranscode({ codec: 'ALAC' })).toBe(true);
    expect(castNeedsTranscode({ codec: 'wmav2' })).toBe(true);
    expect(castNeedsTranscode({ codec: 'ac3' })).toBe(true);
    expect(castNeedsTranscode({ codec: '' })).toBe(false); // unprobed: try it as it is
  });

  it('prefers the chapters response', () => {
    expect(castNeedsTranscode({ codec: 'aac' }, { codec: 'alac' })).toBe(true);
    expect(castNeedsTranscode({ codec: 'aac' }, { direct_playable: false })).toBe(true);
  });
});

describe('isReachableByReceiver', () => {
  it.each([
    ['http://localhost:8080', false],
    ['http://LOCALHOST', false],
    ['http://audiosilo.localhost', false],
    ['http://127.0.0.1:8080', false],
    ['http://127.1.2.3', false],
    ['http://[::1]:8080', false],
    ['http://0.0.0.0', false],
    ['/web', false],
    ['', false],
    ['http://192.168.1.10:8080', true],
    ['https://books.example.com', true],
    ['http://nas.local', true],
    ['http://[fd00::1]:8080', true],
    ['https://user@books.example.com', true],
  ])('%s -> %s', (url, ok) => {
    expect(isReachableByReceiver(url)).toBe(ok);
  });
});

describe('castBlockReason', () => {
  const ok = { canCast: true, canTranscode: true, baseUrl: 'http://192.168.1.2' };
  it('allows a castable book', () => {
    expect(castBlockReason(ok)).toBeNull();
    expect(castBlockReason({ ...ok, book: { codec: 'alac' } })).toBeNull(); // transcoded
  });
  it('names each block', () => {
    expect(castBlockReason({ ...ok, baseUrl: null })).toBe('no-connection');
    expect(castBlockReason({ ...ok, canCast: false })).toBe('unsupported');
    expect(castBlockReason({ ...ok, baseUrl: 'http://localhost:8080' })).toBe('local-address');
    expect(castBlockReason({ ...ok, canTranscode: false, book: { codec: 'alac' } })).toBe('codec');
  });
  it('blocks nothing on what is not known yet', () => {
    expect(castBlockReason({ ...ok, canCast: undefined, canTranscode: undefined })).toBeNull();
    expect(castBlockReason({ ...ok, canTranscode: undefined, book: { codec: 'alac' } })).toBeNull();
  });
});

describe('castContentType', () => {
  it.each([
    ['a/01.mp3', 'audio/mpeg'],
    ['a/book.M4B', 'audio/mp4'],
    ['a/book.m4a', 'audio/mp4'],
    ['a/book.ogg', 'audio/ogg'],
    ['a/book.opus', 'audio/ogg'],
    ['a/book.flac', 'audio/flac'],
    ['a/book.wav', 'audio/wav'],
    ['a/book', 'audio/mpeg'],
  ])('%s -> %s', (path, type) => {
    expect(castContentType(path)).toBe(type);
  });
  it('is MP3 for a transcoded stream', () => {
    expect(castContentType('a/book.m4b', true)).toBe('audio/mpeg');
  });
});

describe('trackFilePath', () => {
  it('takes everything after the library id, colons in the path included', () => {
    expect(trackFilePath({ id: '2:Author/Book: A Novel/01.mp3' })).toBe(
      'Author/Book: A Novel/01.mp3',
    );
  });
});

describe('buildCastItems', () => {
  it('builds one item per track, in track order, with the cast token and never the session token', () => {
    const items = buildCastItems([track('B/01.mp3', 600), track('B/02.mp3', 0)], BOOK, urls, false);
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.index)).toEqual([0, 1]);
    expect(items[0].url).toBe('https://h/api/v1/libraries/2/stream?path=B%2F01.mp3&token=CAST');
    expect(items.every((i) => !i.url.includes('SESSION'))).toBe(true);
    expect(items[0].cover).toBe('https://h/api/v1/libraries/2/cover?path=Author%2FBook&token=CAST');
    expect(items[0]).toMatchObject({
      contentType: 'audio/mpeg',
      duration: 600,
      title: 'Book',
      artist: 'Author',
      album: 'Series',
      transcoded: false,
    });
    expect(items[1].duration).toBeUndefined(); // an unknown duration is left to the receiver
  });

  it('streams every file through the transcoder when asked', () => {
    const [item] = buildCastItems([track('B/book.m4b', 100)], BOOK, urls, true);
    expect(item.url).toContain('transcode=1');
    expect(item.contentType).toBe('audio/mpeg');
    expect(item.transcoded).toBe(true);
  });
});

describe('itemStartingAt', () => {
  const [direct] = buildCastItems([track('B/01.mp3', 600)], BOOK, urls, false);
  const [coded] = buildCastItems([track('B/01.m4b', 600)], BOOK, urls, true);

  it('leaves a direct stream alone (the receiver seeks it)', () => {
    expect(itemStartingAt(direct, 120)).toEqual({ item: direct, offset: 0 });
  });

  it('asks a transcoded stream for the place itself, and says where its time 0 is', () => {
    const { item, offset } = itemStartingAt(coded, 120);
    expect(offset).toBe(120);
    expect(item.url).toContain('t=120');
    expect(item.duration).toBe(480);
    expect(itemStartingAt(coded, 0)).toEqual({ item: coded, offset: 0 });
    // never inside the file's last second (nothing left to encode there)
    expect(itemStartingAt(coded, 700).offset).toBe(599);
  });
});

describe('castTrackIndex', () => {
  const sent = ['u0', 'u1?x=1&t=30', 'u2'];
  const status = (s: Partial<CastMediaStatus>): CastMediaStatus => ({
    playerState: 'playing',
    position: 0,
    rate: 1,
    ...s,
  });

  it('matches the content id first (a transcoded t= ignored)', () => {
    expect(castTrackIndex(status({ contentId: 'u2' }), sent)).toBe(2);
    expect(castTrackIndex(status({ contentId: 'u1?x=1&t=90' }), sent)).toBe(1);
  });
  it('falls back to our custom index, then the item id order', () => {
    expect(castTrackIndex(status({ contentId: 'other', customIndex: 1 }), sent)).toBe(1);
    expect(castTrackIndex(status({ currentItemId: 12, queueItemIds: [10, 11, 12] }), sent)).toBe(2);
    expect(castTrackIndex(status({ customIndex: 9 }), sent)).toBeNull();
    expect(castTrackIndex(status({}), sent)).toBeNull();
  });
});

describe('isUnaskedJump', () => {
  const at = 1_000_000;
  const playing = { trackIndex: 0, position: 100, at, playing: true, rate: 1.5 };

  it('is never a jump without a previous sighting', () => {
    expect(isUnaskedJump(null, { trackIndex: 3, position: 0, at })).toBe(false);
  });
  it('expects a playing receiver to have moved on at its speed', () => {
    // 10 s at 1.5x = 15 s on
    expect(isUnaskedJump(playing, { trackIndex: 0, position: 115, at: at + 10_000 })).toBe(false);
    expect(isUnaskedJump(playing, { trackIndex: 0, position: 100, at: at + 10_000 })).toBe(true);
    expect(isUnaskedJump(playing, { trackIndex: 0, position: 300, at: at + 10_000 })).toBe(true);
  });
  it('expects a paused one to stay put', () => {
    const paused = { ...playing, playing: false };
    expect(isUnaskedJump(paused, { trackIndex: 0, position: 102, at: at + 60_000 })).toBe(false);
    expect(isUnaskedJump(paused, { trackIndex: 0, position: 60, at: at + 1_000 })).toBe(true);
  });
  it('reads running on into the next file as natural, anything else as a move', () => {
    expect(isUnaskedJump(playing, { trackIndex: 1, position: 2, at: at + 2_000 })).toBe(false);
    expect(isUnaskedJump(playing, { trackIndex: 1, position: 500, at: at + 2_000 })).toBe(true);
    expect(isUnaskedJump(playing, { trackIndex: 2, position: 0, at: at + 2_000 })).toBe(true);
    expect(isUnaskedJump({ ...playing, trackIndex: 1 }, { trackIndex: 0, position: 0, at })).toBe(
      true,
    );
  });
});
