import { fromSdkStatus, mediaInfoOf, nativeLoadRequest, withLivePosition } from './sdk-shapes';
import type { CastItem, CastMediaStatus, CastQueueLoad } from './types';

const BOOK = { connectionId: 'srv.3', libraryId: 2, path: 'A/B' };
const item = (index: number, extra: Partial<CastItem> = {}): CastItem => ({
  index,
  url: `https://h/s?path=${index}&token=CAST`,
  contentType: 'audio/mp4',
  title: 'Book',
  transcoded: false,
  ...extra,
});

/** Every key at every depth, with its value: the native bridges read `hasKey` and then the
 * value, so none may be undefined. */
function undefinedKeys(value: unknown, path = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => undefinedKeys(v, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) =>
      v === undefined ? [`${path}.${k}`] : undefinedKeys(v, `${path}.${k}`),
    );
  }
  return [];
}

describe('nativeLoadRequest', () => {
  const load: CastQueueLoad = {
    items: [item(0, { duration: 600, cover: 'https://h/c?token=CAST', artist: 'A' }), item(1)],
    startIndex: 1,
    startTime: 42.5,
    rate: 1.25,
    autoplay: true,
    book: BOOK,
    title: 'Series',
  };

  it('loads the book as an audiobook queue at the place and speed', () => {
    const req = nativeLoadRequest(load) as {
      autoplay: boolean;
      playbackRate: number;
      queueData: {
        startIndex: number;
        startTime: number;
        type: string;
        items: { mediaInfo: Record<string, unknown>; customData: unknown }[];
        containerMetadata: Record<string, unknown>;
      };
    };
    expect(req.autoplay).toBe(true);
    expect(req.playbackRate).toBe(1.25);
    expect(req.queueData.startIndex).toBe(1);
    expect(req.queueData.startTime).toBe(42.5);
    expect(req.queueData.type).toBe('audioBook');
    expect(req.queueData.items).toHaveLength(2);
    expect(req.queueData.items[1].customData).toEqual({ index: 1, ...BOOK });
    expect(req.queueData.containerMetadata).toEqual({
      containerType: 'audioBook',
      title: 'Series',
      containerDuration: 600,
      containerImages: [{ url: 'https://h/c?token=CAST' }],
    });
  });

  it('never sends an undefined key (the Android bridge would crash reading it)', () => {
    expect(undefinedKeys(nativeLoadRequest(load))).toEqual([]);
    expect(undefinedKeys(nativeLoadRequest({ ...load, title: '', items: [item(0)] }))).toEqual([]);
  });

  it('describes each file as a buffered stream with music metadata', () => {
    expect(mediaInfoOf(item(0, { duration: 10, artist: 'A', album: 'S' }), BOOK)).toEqual({
      contentId: 'https://h/s?path=0&token=CAST',
      contentUrl: 'https://h/s?path=0&token=CAST',
      contentType: 'audio/mp4',
      streamType: 'buffered',
      streamDuration: 10,
      customData: { index: 0, ...BOOK },
      metadata: { type: 'musicTrack', title: 'Book', artist: 'A', albumTitle: 'S' },
    });
  });
});

describe('fromSdkStatus', () => {
  it('reads the native shape (lower case) and our custom data', () => {
    const s = fromSdkStatus({
      playerState: 'playing',
      idleReason: null,
      currentItemId: 7,
      playbackRate: 1.5,
      streamPosition: 12.5,
      queueItems: [{ itemId: 6 }, { itemId: 7 }],
      mediaInfo: { contentId: 'u1', customData: { index: 1, ...BOOK } },
    });
    expect(s).toEqual({
      playerState: 'playing',
      idleReason: null,
      contentId: 'u1',
      customIndex: 1,
      currentItemId: 7,
      queueItemIds: [6, 7],
      position: 12.5,
      rate: 1.5,
      book: BOOK,
    });
  });

  it('reads the web shape (upper case) and tolerates what is missing', () => {
    const s = fromSdkStatus({ playerState: 'IDLE', idleReason: 'FINISHED', mediaInfo: null });
    expect(s).toMatchObject({ playerState: 'idle', idleReason: 'finished', book: null, rate: 1 });
    expect(Number.isNaN(s?.position)).toBe(true);
    expect(fromSdkStatus(null)).toBeNull();
    expect(fromSdkStatus({ playerState: 'weird' })?.playerState).toBe('idle');
  });

  it("ignores custom data that isn't ours", () => {
    const s = fromSdkStatus({ playerState: 'paused', mediaInfo: { customData: { foo: 1 } } });
    expect(s?.book).toBeNull();
    expect(s?.customIndex).toBeNull();
  });
});

describe('withLivePosition (the session-end read hands back where the receiver is now)', () => {
  const status = (playerState: CastMediaStatus['playerState'], position = 100) =>
    ({ playerState, idleReason: null, position, rate: 1 }) as CastMediaStatus;

  it('takes the live estimate while the receiver plays or buffers', () => {
    // The status is from the receiver's last message (an hour ago); live is now.
    expect(withLivePosition(status('playing'), 3700)?.position).toBe(3700);
    expect(withLivePosition(status('buffering'), 3700)?.position).toBe(3700);
  });

  it("keeps the status' own place when paused, idle, or without a usable estimate", () => {
    expect(withLivePosition(status('paused'), 3700)?.position).toBe(100);
    expect(withLivePosition(status('idle'), 3700)?.position).toBe(100);
    expect(withLivePosition(status('playing'), 0)?.position).toBe(100); // a session gone
    expect(withLivePosition(status('playing'), null)?.position).toBe(100);
    expect(withLivePosition(status('playing'), Number.NaN)?.position).toBe(100);
    expect(withLivePosition(null, 3700)).toBeNull();
  });
});
