import type { PlaybackTrack } from '@/playback/types';

const mockResolveClient = jest.fn();
jest.mock('@/api/connection-clients', () => ({
  resolveClient: (cid: string) => mockResolveClient(cid),
}));
const mockCaps = jest.fn();
const mockPodcastLibrary = jest.fn(() => false);
jest.mock('@/api/hooks', () => ({
  fetchCapabilities: () => mockCaps(),
  cachedPodcastLibrary: () => mockPodcastLibrary(),
}));
const mockSource = jest.fn();
jest.mock('@/playback/book-source', () => ({ bookSourceOf: () => mockSource() }));

/* eslint-disable import/first */
import { ApiClient, ApiError } from '@/api/client';

import { CastBlockedError, prepareCast } from './cast-prepare';
import { castTokens } from './cast-token';
/* eslint-enable import/first */

const BOOK = { connectionId: 'srv.3', libraryId: 2, path: 'A/B' };
const TRACKS: PlaybackTrack[] = [
  { id: '2:A/B/01.m4b', url: 'file:///local/01.m4b', title: 'B', duration: 100 },
];

describe('prepareCast', () => {
  let castToken: jest.Mock;
  beforeEach(() => {
    castTokens.clear();
    const client = new ApiClient('http://192.168.1.5:8080', 'SESSION-TOKEN');
    castToken = jest.fn(async () => ({
      token: 'CAST-TOKEN',
      expires_at: '2099-01-01T00:00:00.000Z',
    }));
    (client as unknown as { castToken: jest.Mock }).castToken = castToken;
    mockResolveClient.mockReturnValue(client);
    mockCaps.mockResolvedValue({ cast: true, transcode: true });
    mockSource.mockResolvedValue({ book: { codec: 'aac', direct_playable: true } });
    mockPodcastLibrary.mockReturnValue(false);
  });

  it("builds the receiver's URLs on the connection's address with a cast token, never the session token", async () => {
    const { items } = await prepareCast(TRACKS, BOOK);
    expect(castToken).toHaveBeenCalledWith(2, 'A/B');
    expect(items[0].url).toBe(
      'http://192.168.1.5:8080/api/v1/libraries/2/stream?path=A%2FB%2F01.m4b&token=CAST-TOKEN',
    );
    expect(items[0].cover).toContain('token=CAST-TOKEN');
    expect(JSON.stringify(items)).not.toContain('SESSION-TOKEN');
    expect(JSON.stringify(items)).not.toContain('file://'); // a downloaded book casts from its server
    expect(items[0].contentType).toBe('audio/mp4');
  });

  it('transcodes a codec the receiver cannot play when the server can', async () => {
    mockSource.mockResolvedValue({ book: { codec: 'alac' } });
    const { items } = await prepareCast(TRACKS, BOOK);
    expect(items[0].url).toContain('transcode=1');
    expect(items[0].contentType).toBe('audio/mpeg');
  });

  it.each([
    ['no-connection', () => mockResolveClient.mockReturnValue(null)],
    ['unsupported', () => mockCaps.mockResolvedValue({ cast: false, transcode: true })],
    ['unsupported', () => mockCaps.mockRejectedValue(new Error('offline'))],
    [
      'local-address',
      () => mockResolveClient.mockReturnValue(new ApiClient('http://localhost:8080', 's')),
    ],
    [
      'codec',
      () => {
        mockCaps.mockResolvedValue({ cast: true, transcode: false });
        mockSource.mockResolvedValue({ book: { codec: 'wmav2' } });
      },
    ],
    // A podcast episode (an episode started while a book is cast): by its item, or by its
    // library before the item is known.
    [
      'episode',
      () => mockSource.mockResolvedValue({ book: { codec: 'mp3', episode: { show_path: 'S' } } }),
    ],
    ['episode', () => mockPodcastLibrary.mockReturnValue(true)],
  ])('refuses with %s', async (reason, arrange) => {
    arrange();
    const err = await prepareCast(TRACKS, BOOK).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CastBlockedError);
    expect((err as CastBlockedError).reason).toBe(reason);
    expect(castToken).not.toHaveBeenCalled();
  });

  it("reads a v2.4.0 server's not_a_book refusal of the token as an episode", async () => {
    castToken.mockRejectedValue(new ApiError(403, 'Only a book can be cast.', 'not_a_book'));
    const err = await prepareCast(TRACKS, BOOK).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CastBlockedError);
    expect((err as CastBlockedError).reason).toBe('episode');
  });

  it('passes any other token refusal on as it is', async () => {
    const refused = new ApiError(403, 'no access to this library');
    castToken.mockRejectedValue(refused);
    await expect(prepareCast(TRACKS, BOOK)).rejects.toBe(refused);
  });
});
