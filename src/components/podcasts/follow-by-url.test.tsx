import { fireEvent, screen } from '@testing-library/react-native';

import { ApiError } from '@/api/client';
import type { PodcastFollowResult } from '@/api/types';
import { podcastShow } from '@/testing/podcast-fixtures';
import { mountWithPortal } from '@/testing/render-overlay';

const mockOpenShow = jest.fn();
jest.mock('@/lib/open', () => ({
  useOpen: () => ({ openPodcastShow: (...a: unknown[]) => mockOpenShow(...a) }),
}));
const mockFollow = jest.fn();
jest.mock('@/api/hooks', () => {
  const { CapabilityError } = jest.requireActual('@/api/hooks');
  return {
    CapabilityError,
    useFollowPodcastByUrl: () => ({ mutateAsync: mockFollow, isPending: false }),
  };
});

/* eslint-disable import/first */
import { FollowByUrl } from './follow-by-url';
/* eslint-enable import/first */

const FEED = 'https://example.com/feed.xml';

const mount = () => mountWithPortal(<FollowByUrl connectionId="c1" libraryId={7} />);

async function follow(address: string) {
  await fireEvent.changeText(screen.getByTestId('feed-address'), address);
  await fireEvent.press(screen.getByTestId('follow-by-url-submit'));
}

beforeEach(() => {
  mockFollow.mockReset();
  mockOpenShow.mockReset();
});

describe('FollowByUrl', () => {
  it.each([
    ['', 'Paste a feed address.'],
    ['example.com/feed.xml', 'Use an address starting with http:// or https://.'],
    ['ftp://example.com/feed', 'Use an address starting with http:// or https://.'],
    [`https://example.com/${'a'.repeat(2048)}`, 'That address is too long.'],
  ])('checks %j here first and sends nothing', async (address, copy) => {
    await mount();
    await follow(address);
    expect(screen.getByText(copy)).toBeTruthy();
    expect(mockFollow).not.toHaveBeenCalled();
  });

  it('sends the trimmed address, a public feed by default; a new show reads Adding', async () => {
    mockFollow.mockResolvedValue({
      state: 'subscribing',
      request: { id: 1 },
    } as unknown as PodcastFollowResult);
    await mount();
    await follow(`  ${FEED} `);
    expect(mockFollow).toHaveBeenCalledWith({ libraryId: 7, feedUrl: FEED, private: false });
    expect(await screen.findByTestId('follow-by-url-adding')).toBeTruthy();
    // The form clears for the next one.
    expect(screen.getByTestId('feed-address').props.value).toBe('');
  });

  it('sends a private feed as private', async () => {
    mockFollow.mockResolvedValue({ state: 'subscribing', request: { id: 1 } });
    await mount();
    await fireEvent(screen.getByTestId('private-feed'), 'onCheckedChange', true);
    await follow(FEED);
    expect(mockFollow).toHaveBeenCalledWith({ libraryId: 7, feedUrl: FEED, private: true });
  });

  it('a show the library has is followed at once, with Open show', async () => {
    mockFollow.mockResolvedValue({
      state: 'following',
      show: podcastShow({ library_id: 7, path: 'Daily News', title: 'Daily News' }),
    } satisfies PodcastFollowResult);
    await mount();
    await follow(FEED);
    expect(await screen.findByText('You follow Daily News.')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Open show' }));
    expect(mockOpenShow).toHaveBeenCalledWith('c1', 7, 'Daily News');
  });

  it('says a feed asked for as private joined the public show the library had (R-25)', async () => {
    mockFollow.mockResolvedValue({
      state: 'following',
      show: podcastShow({ library_id: 7, path: 'Daily News', title: 'Daily News', private: false }),
    } satisfies PodcastFollowResult);
    await mount();
    await fireEvent(screen.getByTestId('private-feed'), 'onCheckedChange', true);
    await follow(FEED);
    expect((await screen.findByTestId('follow-by-url-following')).props.children).toBe(
      "You follow Daily News. It was already in this library as a public feed, so it isn't private.",
    );
  });

  it('says nothing more when the private feed it asked for is private', async () => {
    mockFollow.mockResolvedValue({
      state: 'following',
      show: podcastShow({ library_id: 7, path: 'Mine', title: 'Mine', private: true }),
    } satisfies PodcastFollowResult);
    await mount();
    await fireEvent(screen.getByTestId('private-feed'), 'onCheckedChange', true);
    await follow(FEED);
    expect((await screen.findByTestId('follow-by-url-following')).props.children).toBe(
      'You follow Mine.',
    );
  });

  it.each([
    ['invalid_feed_url', 400, "That feed address can't be used. Check it and try again."],
    [
      'privacy_conflict',
      409,
      'This feed is already being added with the other privacy setting. Wait for it to finish, then try again.',
    ],
    ['bridge_unavailable', 503, "Your server can't add new shows right now. Try again later."],
    ['library_not_writable', 409, "Your server can't save shows to this library."],
    ['no_library_access', 403, 'You can add shows only to a library shared with you in full.'],
    ['not_podcast_library', 400, "This library isn't for podcasts."],
  ])('shows %s as the field error', async (code, status, copy) => {
    mockFollow.mockRejectedValue(new ApiError(status, 'no', code));
    await mount();
    await follow(FEED);
    expect(await screen.findByText(copy)).toBeTruthy();
    // The address stays, to fix and send again.
    expect(screen.getByTestId('feed-address').props.value).toBe(FEED);
  });
});
