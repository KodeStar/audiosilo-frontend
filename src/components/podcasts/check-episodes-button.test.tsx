import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';

import { ApiError } from '@/api/client';
import type { PodcastShow } from '@/api/types';
import { podcastShow } from '@/testing/podcast-fixtures';

let mockCanFollow: boolean | undefined = true;
const mockCheck = jest.fn();
jest.mock('@/api/hooks', () => {
  const actual = jest.requireActual('@/api/hooks');
  return {
    CapabilityError: actual.CapabilityError,
    qk: actual.qk,
    useCapability: () => mockCanFollow,
    useCheckPodcast: () => ({ mutateAsync: mockCheck, isPending: false }),
  };
});
const mockToast = jest.fn();
jest.mock('@/components/ui/toast', () => ({ toast: (o: unknown) => mockToast(o) }));

/* eslint-disable import/first */
import { qk } from '@/api/hooks';
import { useSession } from '@/stores/session';

import { CHECK_POLL_MS, CHECK_WAIT_MS, CheckEpisodesButton } from './check-episodes-button';
/* eslint-enable import/first */

const signIn = (user: object = {}) =>
  useSession.setState({
    connections: [{ id: 'c1', name: 'Home', serverUrl: 'u', token: 't', user } as never],
  });

let qc: QueryClient;
const tree = (show: PodcastShow) => (
  <QueryClientProvider client={qc}>
    <CheckEpisodesButton connectionId="c1" show={show} />
  </QueryClientProvider>
);
const mount = (show: PodcastShow = podcastShow({ following: true })) => render(tree(show));
const checkedAt = (show: PodcastShow, at: string | null): PodcastShow => ({
  ...show,
  status: { ...show.status, last_checked: at },
});
const showsKey = (show: PodcastShow) => ({ queryKey: qk.podcastShows('c1', show.library_id) });
const episodesKey = (show: PodcastShow) => ({
  queryKey: qk.podcastEpisodesOfShow('c1', show.library_id, show.path),
});

beforeEach(() => {
  jest.useFakeTimers();
  qc = new QueryClient();
  mockCanFollow = true;
  mockCheck.mockReset().mockResolvedValue({ request: { id: 3, state: 'queued' } });
  mockToast.mockReset();
  signIn();
});
afterEach(() => {
  qc.clear();
  jest.useRealTimers();
});

describe('CheckEpisodesButton', () => {
  it('says it asked the server until the show was checked, then reads the episodes (BRIDGE-15)', async () => {
    const show = checkedAt(podcastShow({ following: true }), '2026-10-27T10:00:00Z');
    const invalidate = jest.spyOn(qc, 'invalidateQueries');
    const view = await mount(show);
    await fireEvent.press(screen.getByRole('button', { name: 'Check for new episodes' }));
    expect(mockCheck).toHaveBeenCalledWith({ libraryId: show.library_id, path: show.path });
    const button = screen.getByTestId('podcast-check');
    expect(within(button).getByText('Asked the server to check')).toBeTruthy();
    expect(screen.getByRole('button', { busy: true })).toBe(button);
    // The show is read again while the check runs; the episodes are not yet.
    await act(async () => jest.advanceTimersByTime(CHECK_POLL_MS));
    // A slow list read is left to finish, not restarted by each tick.
    expect(invalidate).toHaveBeenCalledWith(showsKey(show), { cancelRefetch: false });
    expect(invalidate).not.toHaveBeenCalledWith(episodesKey(show));
    // Still running at 10 s (where the old button went quiet).
    await act(async () => jest.advanceTimersByTime(10_000));
    expect(screen.getByText('Asked the server to check')).toBeTruthy();
    // The show list answers with a newer last check: done.
    await view.rerender(tree(checkedAt(show, '2026-10-27T10:00:14Z')));
    expect(screen.getByText('Check for new episodes')).toBeTruthy();
    expect(invalidate).toHaveBeenCalledWith(episodesKey(show));
    invalidate.mockClear();
    await act(async () => jest.advanceTimersByTime(CHECK_WAIT_MS));
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('ends for a show never checked before once it has been', async () => {
    const show = checkedAt(podcastShow({ following: true }), null);
    const view = await mount(show);
    await fireEvent.press(screen.getByTestId('podcast-check'));
    await view.rerender(tree(show));
    expect(screen.getByText('Asked the server to check')).toBeTruthy();
    await view.rerender(tree(checkedAt(show, '2026-10-27T10:00:14Z')));
    expect(screen.getByText('Check for new episodes')).toBeTruthy();
  });

  it('stops waiting after a while and reads the show and episodes once more', async () => {
    const show = checkedAt(podcastShow({ following: true }), '2026-10-27T10:00:00Z');
    const invalidate = jest.spyOn(qc, 'invalidateQueries');
    await mount(show);
    await fireEvent.press(screen.getByTestId('podcast-check'));
    await act(async () => jest.advanceTimersByTime(CHECK_WAIT_MS));
    expect(screen.getByText('Check for new episodes')).toBeTruthy();
    expect(invalidate).toHaveBeenCalledWith(episodesKey(show));
  });

  it('reads nothing again once the page has gone', async () => {
    const invalidate = jest.spyOn(qc, 'invalidateQueries');
    const view = await mount();
    await fireEvent.press(screen.getByTestId('podcast-check'));
    await view.unmount();
    await act(async () => jest.advanceTimersByTime(CHECK_WAIT_MS));
    expect(invalidate).not.toHaveBeenCalled();
  });

  it.each([
    ['checked_recently', 429, 'Checked less than a minute ago. Try again shortly.'],
    ['bridge_unavailable', 503, "Your server can't check feeds right now. Try again later."],
    ['internal', 500, "Couldn't check this show. Try again."],
  ])('says why a check was refused (%s)', async (code, status, copy) => {
    mockCheck.mockRejectedValue(new ApiError(status, 'no', code));
    await mount();
    await fireEvent.press(screen.getByTestId('podcast-check'));
    expect(mockToast).toHaveBeenCalledWith({ title: copy });
    expect(screen.getByText('Check for new episodes')).toBeTruthy();
  });

  it('is only for a show the listener follows', async () => {
    await mount(podcastShow({ following: false }));
    expect(screen.queryByTestId('podcast-check')).toBeNull();
  });

  it('is not offered when the server cannot follow, to a kid, or in the demo', async () => {
    mockCanFollow = false;
    const view = await mount();
    expect(screen.queryByTestId('podcast-check')).toBeNull();
    await view.unmount();

    mockCanFollow = true;
    signIn({ member_kind: 'kid' });
    const kid = await mount();
    expect(screen.queryByTestId('podcast-check')).toBeNull();
    await kid.unmount();

    signIn({ is_demo: true });
    await mount();
    expect(screen.queryByTestId('podcast-check')).toBeNull();
  });
});
