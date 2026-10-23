import { fireEvent, screen } from '@testing-library/react-native';
import { View } from 'react-native';

import { ApiError } from '@/api/client';
import type { PodcastSearchParams } from '@/api/hooks';
import type { PodcastDiscoveryResult, PodcastFollowResult, PodcastRequest } from '@/api/types';
import { podcastShow } from '@/testing/podcast-fixtures';
import { mountWithPortal } from '@/testing/render-overlay';

jest.mock('@/components/player/mini-player', () => ({ useMiniPlayerInset: () => 0 }));
jest.mock('./discovery-artwork', () => ({ DiscoveryArtwork: () => null }));
jest.mock('./discovery-country', () => ({ deviceCountry: () => 'GB' }));
const mockToast = jest.fn();
jest.mock('@/components/ui/toast', () => ({ toast: (o: unknown) => mockToast(o) }));
const mockOpenShow = jest.fn();
jest.mock('@/lib/open', () => ({
  useOpen: () => ({ openPodcastShow: (...a: unknown[]) => mockOpenShow(...a) }),
}));

type SearchState = {
  data?: { provider: string; query: string; country: string | null; results: unknown[] };
  isError?: boolean;
  error?: unknown;
  isPending?: boolean;
  isFetching?: boolean;
};
let mockIndex = false;
let mockCanFollow = true;
let mockSearch: SearchState = {};
const mockAsked: (PodcastSearchParams | null)[] = [];
const mockRefetch = jest.fn();
const mockFollow = jest.fn();
jest.mock('expo-router', () => ({ useIsFocused: () => true }));
let mockRequests: Partial<PodcastRequest>[] = [];
jest.mock('@/api/hooks', () => {
  const { CapabilityError } = jest.requireActual('@/api/hooks');
  return {
    CapabilityError,
    useCapability: (flag: string) => (flag === 'podcasts' ? mockCanFollow : true),
    usePodcastDiscoveryProviders: () => ({
      data: {
        providers: [
          { id: 'itunes', available: true },
          { id: 'podcast_index', available: mockIndex },
        ],
      },
    }),
    usePodcastSearch: (params: PodcastSearchParams | null) => {
      mockAsked.push(params);
      return params
        ? {
            isPending: false,
            isFetching: false,
            isError: false,
            refetch: mockRefetch,
            ...mockSearch,
          }
        : { isPending: true, isFetching: false, isError: false, refetch: mockRefetch };
    },
    useFollowPodcastByUrl: () => ({ mutateAsync: mockFollow, isPending: false }),
    useFollowRequests: () => ({ data: mockRequests }),
  };
});

/* eslint-disable import/first */
import { DirectorySearch } from './directory-search';
/* eslint-enable import/first */

const result = (over: Partial<PodcastDiscoveryResult> = {}): PodcastDiscoveryResult => ({
  title: 'History Hour',
  author: 'The Archive',
  feed_url: 'https://feeds.example.com/history.xml',
  artwork_url: null,
  provider_ids: { itunes: '123', podcast_index: null },
  episode_count: 42,
  provider_url: 'https://podcasts.apple.com/podcast/id123',
  ...over,
});

const lastAsked = () => mockAsked.at(-1) ?? null;

const mount = () =>
  mountWithPortal(
    <DirectorySearch
      connectionId="c1"
      libraryId={7}
      header={<View testID="header" />}
      footer={<View testID="footer" />}
    />,
  );

async function search(text: string) {
  await fireEvent.changeText(screen.getByTestId('directory-search-input'), text);
  await fireEvent.press(screen.getByTestId('directory-search-submit'));
}

beforeEach(() => {
  mockIndex = false;
  mockCanFollow = true;
  mockSearch = {};
  mockAsked.length = 0;
  mockRefetch.mockReset();
  mockFollow.mockReset();
  mockToast.mockReset();
  mockOpenShow.mockReset();
  mockRequests = [];
});

describe('DirectorySearch', () => {
  it('searches only when submitted, with the device region for Apple Podcasts', async () => {
    await mount();
    await fireEvent.changeText(screen.getByTestId('directory-search-input'), 'history');
    expect(lastAsked()).toBeNull();
    await fireEvent.press(screen.getByTestId('directory-search-submit'));
    expect(lastAsked()).toEqual({ q: 'history', provider: 'itunes', country: 'GB', limit: 20 });
    expect(screen.getByTestId('header')).toBeTruthy();
    expect(screen.getByTestId('footer')).toBeTruthy();
  });

  it('refuses a search shorter than two characters without asking', async () => {
    await mount();
    await search(' a ');
    expect(screen.getByText('Type at least 2 characters.')).toBeTruthy();
    expect(lastAsked()).toBeNull();
  });

  it('has no picker, and credits Apple Podcasts, when Podcast Index is not offered', async () => {
    await mount();
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(screen.getByTestId('directory-attribution').props.children).toBe(
      'Results from Apple Podcasts',
    );
  });

  it('offers Podcast Index when the server has it, and a change searches it at once', async () => {
    mockIndex = true;
    await mount();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    await search('history');
    expect(lastAsked()).toMatchObject({ provider: 'itunes', country: 'GB' });
    await fireEvent.press(screen.getByRole('radio', { name: 'Podcast Index' }));
    expect(lastAsked()).toEqual({
      q: 'history',
      provider: 'podcast_index',
      country: null,
      limit: 20,
    });
  });

  it('shows the results and who they came from', async () => {
    mockIndex = true;
    mockSearch = {
      data: {
        provider: 'podcast_index',
        query: 'history',
        country: null,
        results: [result(), result({ feed_url: 'https://b.example/feed', title: 'Other' })],
      },
    };
    await mount();
    await search('history');
    expect(screen.getAllByTestId('discovery-result')).toHaveLength(2);
    expect(screen.getByText('History Hour')).toBeTruthy();
    expect(screen.getAllByText('42 episodes')).toHaveLength(2);
    expect(screen.getByTestId('directory-attribution').props.children).toBe(
      'Results from Podcast Index',
    );
    expect(screen.getAllByRole('button', { name: 'View on Podcast Index' })).toHaveLength(2);
  });

  it('says when nothing was found', async () => {
    mockSearch = { data: { provider: 'itunes', query: 'zz', country: 'GB', results: [] } };
    await mount();
    await search('zz');
    expect(screen.getByText('No shows found')).toBeTruthy();
  });

  it('shows the wait the server asked for, and Search again asks again', async () => {
    mockSearch = {
      isError: true,
      error: new ApiError(429, 'slow down', 'discovery_rate_limited', 12),
    };
    await mount();
    await search('history');
    expect(screen.getByText("You've searched a lot just now. Try again in 12 s.")).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Search again' }));
    expect(mockRefetch).toHaveBeenCalledTimes(1);
    // Submitting the same failed search asks again too, rather than holding the failure.
    await fireEvent.press(screen.getByTestId('directory-search-submit'));
    expect(mockRefetch).toHaveBeenCalledTimes(2);
  });

  it('maps a refusal of the provider to its own copy', async () => {
    mockSearch = { isError: true, error: new ApiError(502, 'no', 'provider_rejected') };
    await mount();
    await search('history');
    expect(
      screen.getByText("Your server can't use Podcast Index right now. Try Apple Podcasts."),
    ).toBeTruthy();
  });

  it('follows a result by its feed address; a request on its way reads Adding', async () => {
    mockSearch = { data: { provider: 'itunes', query: 'h', country: 'GB', results: [result()] } };
    mockFollow.mockResolvedValue({
      state: 'subscribing',
      request: { id: 3 },
    } as unknown as PodcastFollowResult);
    // The follow put its request in the cached list (`storeFollowByUrl`).
    mockRequests = [{ id: 3, state: 'queued', library_id: 7, show_path: null }];
    await mount();
    await search('history');
    await fireEvent.press(screen.getByRole('button', { name: 'Follow History Hour' }));
    expect(mockFollow).toHaveBeenCalledWith({
      libraryId: 7,
      feedUrl: 'https://feeds.example.com/history.xml',
    });
    expect(await screen.findByTestId('discovery-result-adding')).toBeTruthy();
  });

  it('a result on its way turns Following once its request is done, or says it failed', async () => {
    mockSearch = {
      data: {
        provider: 'itunes',
        query: 'h',
        country: 'GB',
        results: [result(), result({ feed_url: 'https://b.example/feed', title: 'Other' })],
      },
    };
    mockFollow
      .mockResolvedValueOnce({ state: 'subscribing', request: { id: 3 } })
      .mockResolvedValueOnce({ state: 'subscribing', request: { id: 4 } });
    mockRequests = [
      { id: 3, state: 'running', library_id: 7, show_path: null },
      { id: 4, state: 'queued', library_id: 7, show_path: null },
    ];
    await mount();
    await search('history');
    await fireEvent.press(screen.getByRole('button', { name: 'Follow History Hour' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Follow Other' }));
    expect(await screen.findAllByTestId('discovery-result-adding')).toHaveLength(2);

    mockRequests = [
      { id: 3, state: 'done', library_id: 7, show_path: 'History Hour' },
      { id: 4, state: 'failed', library_id: 7, show_path: null },
    ];
    // The requests list polls them; any render reads them again (here, typing).
    await fireEvent.changeText(screen.getByTestId('directory-search-input'), 'history ');
    expect(screen.queryByTestId('discovery-result-adding')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Open show' }));
    expect(mockOpenShow).toHaveBeenCalledWith('c1', 7, 'History Hour');
    expect(screen.getByTestId('discovery-result-failed').props.children).toBe("Couldn't add");
    // A failed one can be followed again.
    expect(screen.getByRole('button', { name: 'Follow Other' })).toBeTruthy();
  });

  it('says Cancelled for a request cancelled, and drops one the list no longer holds (R-24)', async () => {
    mockSearch = {
      data: {
        provider: 'itunes',
        query: 'h',
        country: 'GB',
        results: [result(), result({ feed_url: 'https://b.example/feed', title: 'Other' })],
      },
    };
    mockFollow
      .mockResolvedValueOnce({ state: 'subscribing', request: { id: 3 } })
      .mockResolvedValueOnce({ state: 'subscribing', request: { id: 4 } });
    mockRequests = [
      { id: 3, state: 'queued', library_id: 7, show_path: null },
      { id: 4, state: 'queued', library_id: 7, show_path: null },
    ];
    await mount();
    await search('history');
    await fireEvent.press(screen.getByRole('button', { name: 'Follow History Hour' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Follow Other' }));
    expect(await screen.findAllByTestId('discovery-result-adding')).toHaveLength(2);

    // 3 was cancelled; 4 was pruned from the list (days later): no longer "Adding".
    mockRequests = [{ id: 3, state: 'cancelled', library_id: 7, show_path: null }];
    await fireEvent.changeText(screen.getByTestId('directory-search-input'), 'history ');
    expect(screen.queryByTestId('discovery-result-adding')).toBeNull();
    expect(screen.getByText('Cancelled')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Follow Other' })).toBeTruthy();
  });

  it('a show the library had reads Following, with Open show', async () => {
    mockSearch = { data: { provider: 'itunes', query: 'h', country: 'GB', results: [result()] } };
    mockFollow.mockResolvedValue({
      state: 'following',
      show: podcastShow({ library_id: 7, path: 'History Hour' }),
    } satisfies PodcastFollowResult);
    await mount();
    await search('history');
    await fireEvent.press(screen.getByRole('button', { name: 'Follow History Hour' }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Open show' }));
    expect(mockOpenShow).toHaveBeenCalledWith('c1', 7, 'History Hour');
  });

  it('toasts why a follow was refused', async () => {
    mockSearch = { data: { provider: 'itunes', query: 'h', country: 'GB', results: [result()] } };
    mockFollow.mockRejectedValue(new ApiError(429, 'busy', 'too_many_requests'));
    await mount();
    await search('history');
    await fireEvent.press(screen.getByRole('button', { name: 'Follow History Hour' }));
    await screen.findByRole('button', { name: 'Follow History Hour' });
    expect(mockToast).toHaveBeenCalledWith({
      title: 'Five shows are already being added. Try again once one is done.',
    });
  });

  it('offers no Follow when the server cannot follow now', async () => {
    mockCanFollow = false;
    mockSearch = { data: { provider: 'itunes', query: 'h', country: 'GB', results: [result()] } };
    await mount();
    await search('history');
    expect(screen.getByText('History Hour')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Follow History Hour' })).toBeNull();
  });
});
