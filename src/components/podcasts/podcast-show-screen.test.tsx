import { fireEvent, screen } from '@testing-library/react-native';

import type { PodcastShow } from '@/api/types';
import { mountWithPortal } from '@/testing/render-overlay';

let mockParams: Record<string, string | undefined> = {};
const mockSetParams = jest.fn();
const mockBack = jest.fn();
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  router: {
    setParams: (p: unknown) => mockSetParams(p),
    back: () => mockBack(),
    canGoBack: () => true,
  },
}));
jest.mock('@/components/layout/content-scope', () => ({
  ContentScope: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@/api/provider', () => ({ useScopedCid: () => 'c1' }));
jest.mock('@/components/library/book-cover', () => ({ BookCover: () => null }));
jest.mock('@/components/player/mini-player', () => ({ useMiniPlayerInset: () => 0 }));
jest.mock('@/components/ui/toast', () => ({ toast: jest.fn() }));
jest.mock('@/playback/episode-fetch', () => {
  const { create } = jest.requireActual('zustand');
  return { useEpisodeFetch: create(() => ({ pending: null })) };
});
// Check for new episodes has its own suite: here, only that the hero has it.
jest.mock('./check-episodes-button', () => ({
  CheckEpisodesButton: ({ show }: { show: { path: string } }) => {
    const { Text } = jest.requireActual('react-native');
    return <Text testID="check-episodes">{`check ${show.path}`}</Text>;
  },
}));
// The rows have their own suite: here, which episodes in which order.
jest.mock('./episode-row', () => ({
  EpisodeRow: ({ episode }: { episode: { title: string } }) => {
    const { Text } = jest.requireActual('react-native');
    return <Text testID="row">{episode.title}</Text>;
  },
}));

let mockShows: PodcastShow[] | undefined;
let mockCaps: Record<string, boolean | undefined> = {};
const mockEpisodesAsked: string[] = [];
const mockFollow = jest.fn();
const mockUnfollow = jest.fn();
const mockRefetch = jest.fn();
jest.mock('@/api/hooks', () => {
  const { CapabilityError } = jest.requireActual('@/api/hooks');
  return {
    CapabilityError,
    useCapability: (flag: string) => mockCaps[flag],
    usePodcastShows: () => ({
      data: mockShows,
      isPending: mockShows === undefined,
      refetch: mockRefetch,
    }),
    usePodcastEpisodes: (_lib: number, _show: string, order: string) => {
      mockEpisodesAsked.push(order);
      return {
        data: {
          pages: [
            {
              episodes: [
                { path: 'a', title: 'Kept', removed: true, downloaded: true },
                { path: 'b', title: 'Gone', removed: true, downloaded: false },
                { path: 'c', title: 'Live', removed: false, downloaded: false },
              ],
              next_cursor: null,
            },
          ],
        },
        isPending: false,
        hasNextPage: false,
      };
    },
    useProgressLookup: () => ({ progressOf: () => undefined }),
    useFollowPodcast: () => ({ mutateAsync: mockFollow, isPending: false }),
    useUnfollowPodcast: () => ({ mutateAsync: mockUnfollow, isPending: false }),
  };
});

/* eslint-disable import/first */
import { useSession } from '@/stores/session';
import { podcastShow } from '@/testing/podcast-fixtures';

import { PodcastShowScreen } from './podcast-show-screen';
/* eslint-enable import/first */

const signIn = (user: object = {}) =>
  useSession.setState({
    connections: [{ id: 'c1', name: 'Home', serverUrl: 'u', token: 't', user } as never],
  });

beforeEach(() => {
  mockParams = { connection: 'c1', library: '5', show: 'Daily News' };
  mockShows = [podcastShow()];
  mockCaps = { podcasts: true };
  mockEpisodesAsked.length = 0;
  mockFollow.mockReset().mockResolvedValue({});
  mockUnfollow.mockReset().mockResolvedValue(undefined);
  mockBack.mockReset();
  mockSetParams.mockReset();
  signIn();
});

describe('PodcastShowScreen', () => {
  it('shows the show and its episodes, hiding one gone from the feed unless kept', async () => {
    await mountWithPortal(<PodcastShowScreen />);
    expect(screen.getByText('Daily News')).toBeTruthy();
    expect(screen.getByText('8 episodes')).toBeTruthy();
    expect(screen.getAllByTestId('row').map((r) => r.props.children)).toEqual(['Kept', 'Live']);
    expect(screen.getByTestId('check-episodes').props.children).toBe('check Daily News');
  });

  it('reads an episodic show newest first and a serial one oldest first', async () => {
    await mountWithPortal(<PodcastShowScreen />);
    expect(mockEpisodesAsked.at(-1)).toBe('newest');
    mockShows = [podcastShow({ type: 'serial' })];
    await mountWithPortal(<PodcastShowScreen />);
    expect(mockEpisodesAsked.at(-1)).toBe('oldest');
    // The link's order wins, and the control writes it.
    mockParams = { ...mockParams, order: 'newest' };
    await mountWithPortal(<PodcastShowScreen />);
    expect(mockEpisodesAsked.at(-1)).toBe('newest');
    await fireEvent.press(screen.getByRole('radio', { name: 'Oldest first' }));
    expect(mockSetParams).toHaveBeenCalledWith({ order: 'oldest' });
  });

  it('says so when the show is not in its library', async () => {
    mockParams = { ...mockParams, show: 'Elsewhere' };
    await mountWithPortal(<PodcastShowScreen />);
    expect(screen.getByText("This show isn't available")).toBeTruthy();
  });

  it('says that a check failed, never why', async () => {
    mockShows = [
      podcastShow({
        status: {
          last_checked: null,
          last_success: null,
          next_check: null,
          error: { code: 'http_500', message: 'upstream said no' },
        },
      }),
    ];
    await mountWithPortal(<PodcastShowScreen />);
    expect(screen.getByText('Last check failed')).toBeTruthy();
    expect(screen.queryByText(/upstream/)).toBeNull();
  });
});

describe('FollowButton on the show page', () => {
  it('follows and unfollows when the server can', async () => {
    mockShows = [podcastShow({ following: false })];
    await mountWithPortal(<PodcastShowScreen />);
    await fireEvent.press(screen.getByTestId('podcast-follow'));
    expect(mockFollow).toHaveBeenCalledWith({ libraryId: 5, path: 'Daily News' });

    mockShows = [podcastShow({ following: true })];
    await mountWithPortal(<PodcastShowScreen />);
    await fireEvent.press(screen.getByTestId('podcast-unfollow'));
    expect(mockUnfollow).toHaveBeenCalledWith({ libraryId: 5, path: 'Daily News' });
  });

  it.each([
    ['the module is off or its Bridge is away', {}, { podcasts: false }],
    ['the flag is not known yet', {}, {}],
    ["a kid's account", { member_kind: 'kid' }, { podcasts: true }],
    ['the demo', { is_demo: true }, { podcasts: true }],
  ])('is a read-only badge when %s', async (_why, user, caps) => {
    signIn(user);
    mockCaps = caps;
    await mountWithPortal(<PodcastShowScreen />);
    expect(screen.queryByTestId('podcast-unfollow')).toBeNull();
    expect(screen.getByTestId('podcast-following-badge')).toBeTruthy();
    // A show not followed shows nothing.
    mockShows = [podcastShow({ following: false })];
    await mountWithPortal(<PodcastShowScreen />);
    expect(screen.queryByTestId('podcast-follow')).toBeNull();
    expect(screen.queryByTestId('podcast-following-badge')).toBeNull();
  });

  it('asks before unfollowing a private feed, then leaves the page', async () => {
    mockShows = [podcastShow({ private: true, feed_url: null })];
    await mountWithPortal(<PodcastShowScreen />);
    await fireEvent.press(screen.getByTestId('podcast-unfollow'));
    expect(mockUnfollow).not.toHaveBeenCalled();
    expect(screen.getByText("You'll need the feed's address to follow it again.")).toBeTruthy();
    // The dialog's confirm (the Following button is also named Unfollow).
    await fireEvent.press(screen.getAllByRole('button', { name: 'Unfollow' }).at(-1)!);
    expect(mockUnfollow).toHaveBeenCalledTimes(1);
    expect(mockBack).toHaveBeenCalledTimes(1);
  });
});
