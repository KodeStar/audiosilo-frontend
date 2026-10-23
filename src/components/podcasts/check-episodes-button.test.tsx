import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

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

import { CHECK_REFRESH_MS, CheckEpisodesButton } from './check-episodes-button';
/* eslint-enable import/first */

const signIn = (user: object = {}) =>
  useSession.setState({
    connections: [{ id: 'c1', name: 'Home', serverUrl: 'u', token: 't', user } as never],
  });

let qc: QueryClient;
const mount = (show: PodcastShow = podcastShow({ following: true })) =>
  render(
    <QueryClientProvider client={qc}>
      <CheckEpisodesButton connectionId="c1" show={show} />
    </QueryClientProvider>,
  );

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
  it('checks the show, says it started, and reads it again once a while later', async () => {
    const show = podcastShow({ following: true });
    const invalidate = jest.spyOn(qc, 'invalidateQueries');
    await mount(show);
    await fireEvent.press(screen.getByRole('button', { name: 'Check for new episodes' }));
    expect(mockCheck).toHaveBeenCalledWith({ libraryId: show.library_id, path: show.path });
    expect(mockToast).toHaveBeenCalledWith({ title: 'Checking for new episodes' });
    await act(async () => jest.advanceTimersByTime(CHECK_REFRESH_MS - 1));
    expect(invalidate).not.toHaveBeenCalled();
    await act(async () => jest.advanceTimersByTime(1));
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: qk.podcastShows('c1', show.library_id),
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: qk.podcastEpisodesOfShow('c1', show.library_id, show.path),
    });
  });

  it('reads nothing again once the page has gone', async () => {
    const invalidate = jest.spyOn(qc, 'invalidateQueries');
    const view = await mount();
    await fireEvent.press(screen.getByTestId('podcast-check'));
    await view.unmount();
    await act(async () => jest.advanceTimersByTime(CHECK_REFRESH_MS));
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
