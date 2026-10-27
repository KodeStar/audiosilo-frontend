import { act, render, screen } from '@testing-library/react-native';

// A host stand-in for expo-image, so the test can read the source, fire its error and
// count its mounts (each a new request for the URL).
let mockMounts = 0;
jest.mock('expo-image', () => {
  const { useEffect } = jest.requireActual('react');
  const { View } = jest.requireActual('react-native');
  return {
    Image: (props: object) => {
      useEffect(() => {
        mockMounts++;
      }, []);
      return <View {...props} />;
    },
  };
});
const proxied = (rel: string | null): string | null =>
  rel ? `https://s/api/v1/podcasts/discovery/artwork?id=abc&token=m` : null;
const mockArtworkUrl = jest.fn(proxied);
jest.mock('@/api/provider', () => ({
  useOptionalApi: () => ({ discoveryArtworkUrl: (rel: string | null) => mockArtworkUrl(rel) }),
}));

/* eslint-disable import/first */
import { DiscoveryArtwork } from './discovery-artwork';
import { ARTWORK_RETRY_DELAYS_MS, resetArtworkBusy } from './artwork-retry';
/* eslint-enable import/first */

const REL = '/api/v1/podcasts/discovery/artwork?id=abc';

// The frame is hidden from screen readers (decoration), so the query includes it.
const image = () =>
  screen.queryByTestId('discovery-artwork-image', { includeHiddenElements: true });

async function fail() {
  await act(async () => image()!.props.onError());
}

// The probe after a failed load (`nextArtworkTry`): no answer unless a test gives one.
const realFetch = global.fetch;
const mockFetch = jest.fn(async (_uri: string, _init?: RequestInit): Promise<unknown> => {
  throw new TypeError('Network request failed');
});

beforeEach(() => {
  jest.useFakeTimers();
  resetArtworkBusy();
  mockFetch.mockClear();
  global.fetch = mockFetch as unknown as typeof fetch;
  mockArtworkUrl.mockClear().mockImplementation(proxied);
  mockMounts = 0;
});
afterEach(() => {
  jest.useRealTimers();
  global.fetch = realFetch;
});

const answer = (status: number, retryAfter?: string) => ({
  status,
  headers: { get: (h: string) => (h === 'Retry-After' ? (retryAfter ?? null) : null) },
});

describe('DiscoveryArtwork', () => {
  it("loads the server's proxy URL with the media token", async () => {
    await render(<DiscoveryArtwork connectionId="c1" artworkUrl={REL} size={56} />);
    expect(mockArtworkUrl).toHaveBeenCalledWith(REL);
    expect(image()!.props.source).toEqual({
      uri: 'https://s/api/v1/podcasts/discovery/artwork?id=abc&token=m',
    });
  });

  it('shows the placeholder when there is no artwork', async () => {
    await render(<DiscoveryArtwork connectionId="c1" artworkUrl={null} size={56} />);
    expect(image()).toBeNull();
  });

  it('mounts the image again on the retry schedule after a failed load, then gives up', async () => {
    await render(<DiscoveryArtwork connectionId="c1" artworkUrl={REL} size={56} />);
    expect(mockMounts).toBe(1);
    for (const delay of ARTWORK_RETRY_DELAYS_MS) {
      await fail();
      expect(image()).toBeNull();
      await act(async () => jest.advanceTimersByTime(delay - 1));
      expect(image()).toBeNull();
      await act(async () => jest.advanceTimersByTime(1));
      expect(image()).not.toBeNull();
    }
    // Each try was a new mount, so the same URL was asked for again.
    expect(mockMounts).toBe(ARTWORK_RETRY_DELAYS_MS.length + 1);
    await fail();
    await act(async () => jest.advanceTimersByTime(10 * 60_000));
    expect(image()).toBeNull();
  });

  it('starts over for another URL once it gave up on one', async () => {
    mockArtworkUrl.mockImplementation((rel) => (rel ? `https://s${rel}&token=m` : null));
    const view = await render(<DiscoveryArtwork connectionId="c1" artworkUrl={REL} size={56} />);
    for (const delay of ARTWORK_RETRY_DELAYS_MS) {
      await fail();
      await act(async () => jest.advanceTimersByTime(delay));
    }
    await fail();
    expect(image()).toBeNull();
    const other = '/api/v1/podcasts/discovery/artwork?id=def';
    await view.rerender(<DiscoveryArtwork connectionId="c1" artworkUrl={other} size={56} />);
    expect(image()!.props.source).toEqual({ uri: `https://s${other}&token=m` });
  });

  it('stops its timer when it goes away', async () => {
    const view = await render(<DiscoveryArtwork connectionId="c1" artworkUrl={REL} size={56} />);
    await fail();
    const cleared = jest.spyOn(global, 'clearTimeout');
    await view.unmount();
    expect(cleared).toHaveBeenCalled();
    cleared.mockRestore();
    // Nothing mounts or warns once the delay would have passed.
    await act(async () => jest.advanceTimersByTime(ARTWORK_RETRY_DELAYS_MS[0]));
    expect(mockMounts).toBe(1);
  });

  it("waits the server's Retry-After when it is busy (fe#126)", async () => {
    mockFetch.mockResolvedValue(answer(429, '12'));
    await render(<DiscoveryArtwork connectionId="c1" artworkUrl={REL} size={56} />);
    await fail();
    expect(mockFetch).toHaveBeenCalledWith(
      'https://s/api/v1/podcasts/discovery/artwork?id=abc&token=m',
      expect.objectContaining({ method: 'HEAD' }),
    );
    await act(async () => jest.advanceTimersByTime(ARTWORK_RETRY_DELAYS_MS[1]));
    expect(image()).toBeNull();
    await act(async () => jest.advanceTimersByTime(12_000 - ARTWORK_RETRY_DELAYS_MS[1]));
    expect(image()).not.toBeNull();
    expect(mockMounts).toBe(2);
  });

  it('keeps the placeholder for an artwork that is gone, without trying again', async () => {
    mockFetch.mockResolvedValue(answer(404));
    await render(<DiscoveryArtwork connectionId="c1" artworkUrl={REL} size={56} />);
    await fail();
    await act(async () => jest.advanceTimersByTime(10 * 60_000));
    expect(image()).toBeNull();
    expect(mockMounts).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
