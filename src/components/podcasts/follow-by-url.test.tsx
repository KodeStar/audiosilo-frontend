import { fireEvent, screen } from '@testing-library/react-native';

import { ApiError } from '@/api/client';
import type { PodcastFollowResult, PodcastRequest } from '@/api/types';
import { podcastShow } from '@/testing/podcast-fixtures';
import { mountWithPortal } from '@/testing/render-overlay';

let mockOnline = true;
jest.mock('@/lib/device-online', () => ({
  ...jest.requireActual('@/lib/device-online'),
  useDeviceOnline: () => mockOnline,
}));

const mockOpenShow = jest.fn();
jest.mock('@/lib/open', () => ({
  useOpen: () => ({ openPodcastShow: (...a: unknown[]) => mockOpenShow(...a) }),
}));
const mockFollow = jest.fn();
let mockRequests: PodcastRequest[] | undefined;
let mockShows: { path: string; title: string }[] | undefined;
jest.mock('expo-router', () => ({ useIsFocused: () => true }));
jest.mock('@/api/hooks', () => {
  const { CapabilityError } = jest.requireActual('@/api/hooks');
  return {
    CapabilityError,
    useFollowPodcastByUrl: () => ({ mutateAsync: mockFollow, isPending: false }),
    useFollowRequests: () => ({ data: mockRequests }),
    usePodcastShows: () => ({ data: mockShows }),
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
  mockRequests = undefined;
  mockShows = undefined;
  mockOnline = true;
  mockFollow.mockReset();
  mockOpenShow.mockReset();
});

describe('FollowByUrl', () => {
  it('keeps a feed address editable and blocks submitting it offline', async () => {
    mockOnline = false;
    await mount();
    await follow(FEED);
    await fireEvent(screen.getByTestId('feed-address'), 'submitEditing');
    expect(mockFollow).not.toHaveBeenCalled();
    expect(screen.getByTestId('follow-by-url-submit')).toBeDisabled();
    expect(screen.getByText("You're offline. Reconnect to find or add shows.")).toBeTruthy();
    expect(screen.getByTestId('feed-address').props.value).toBe(FEED);
  });

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

  describe('a new show, read live until its request ends (fe#126)', () => {
    const request = (over: Partial<PodcastRequest>): PodcastRequest => ({
      id: 1,
      library_id: 7,
      state: 'running',
      feed: 'https://example.com/...',
      private: false,
      show_path: null,
      error: null,
      created_at: '2026-10-20T10:00:00Z',
      updated_at: '2026-10-20T10:00:00Z',
      ...over,
    });
    const asked = async () => {
      mockFollow.mockResolvedValue({ state: 'subscribing', request: request({}) });
      const view = await mount();
      await follow(FEED);
      await screen.findByTestId('follow-by-url-adding');
      return view;
    };
    const rerender = (view: Awaited<ReturnType<typeof mount>>) =>
      view.rerender(<FollowByUrl connectionId="c1" libraryId={7} />);

    it('says why it could not be added, not Adding, once it failed', async () => {
      const view = await asked();
      mockRequests = [request({ state: 'failed', error: { code: 'not_a_feed', message: 'x' } })];
      await rerender(view);
      expect(screen.queryByTestId('follow-by-url-adding')).toBeNull();
      expect(screen.getByTestId('follow-by-url-failed').props.children).toBe(
        "Couldn't add the show. That address isn't a podcast feed.",
      );
    });

    it('says it was cancelled', async () => {
      const view = await asked();
      mockRequests = [request({ state: 'cancelled' })];
      await rerender(view);
      expect(screen.getByTestId('follow-by-url-cancelled')).toBeTruthy();
    });

    it('offers Open show once it is added', async () => {
      const view = await asked();
      mockShows = [{ path: 'New Show', title: 'The New Show' }];
      mockRequests = [request({ state: 'done', show_path: 'New Show' })];
      await rerender(view);
      expect(screen.getByTestId('follow-by-url-following').props.children).toBe(
        'You follow The New Show.',
      );
      await fireEvent.press(screen.getByRole('button', { name: 'Open show' }));
      expect(mockOpenShow).toHaveBeenCalledWith('c1', 7, 'New Show');
    });

    it('keeps Adding while it is open, or before the list is read', async () => {
      const view = await asked();
      expect(screen.getByTestId('follow-by-url-adding')).toBeTruthy();
      mockRequests = [request({ state: 'queued' })];
      await rerender(view);
      expect(screen.getByTestId('follow-by-url-adding')).toBeTruthy();
    });

    it('says nothing once the list no longer holds it (dismissed), never Adding again', async () => {
      const view = await asked();
      mockRequests = [request({ state: 'failed', error: { code: 'not_a_feed', message: 'x' } })];
      await rerender(view);
      expect(screen.getByTestId('follow-by-url-failed')).toBeTruthy();
      mockRequests = [];
      await rerender(view);
      expect(screen.queryByTestId('follow-by-url-failed')).toBeNull();
      expect(screen.queryByTestId('follow-by-url-adding')).toBeNull();
    });
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
