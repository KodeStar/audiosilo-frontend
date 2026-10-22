import { act, fireEvent, render, screen } from '@testing-library/react-native';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@/components/library/book-cover', () => ({ BookCover: () => null }));
const mockRetry = jest.fn();
const mockCancel = jest.fn();
jest.mock('@/playback/episode-fetch', () => {
  const { create } = jest.requireActual('zustand');
  return {
    useEpisodeFetch: create(() => ({ pending: null })),
    // The controller's rule (its module pulls in the player store).
    isStopped: (phase: string) => ['failed', 'unavailable', 'refused'].includes(phase),
    retryEpisodeFetch: () => mockRetry(),
    cancelEpisodeFetch: () => mockCancel(),
  };
});

/* eslint-disable import/first */
import { type PendingEpisodeFetch, useEpisodeFetch } from '@/playback/episode-fetch';
import { fetchStatus, wire2b } from '@/testing/podcast-fixtures';

import { EpisodeFetchPanel, EpisodeFetchStrip } from './episode-fetch-panel';
/* eslint-enable import/first */

const pending = (over: Partial<PendingEpisodeFetch> = {}): PendingEpisodeFetch => ({
  key: 'c1:5:Daily News/Monday.mp3',
  target: { connectionId: 'c1', libraryId: 5, path: 'Daily News/Monday.mp3' },
  title: 'Monday',
  show: 'Daily News',
  opts: {},
  phase: 'waiting',
  status: wire2b.status_response.fetch,
  code: null,
  ...over,
});

beforeEach(() => {
  mockRetry.mockReset();
  mockCancel.mockReset();
  useEpisodeFetch.setState({ pending: null });
});

describe('EpisodeFetchPanel', () => {
  it('shows the episode, its show and how far the fetch is, with Cancel only', async () => {
    useEpisodeFetch.setState({ pending: pending() });
    await render(<EpisodeFetchPanel onClose={jest.fn()} />);
    expect(screen.getByText('Monday')).toBeTruthy();
    expect(screen.getByText('Daily News')).toBeTruthy();
    expect(screen.getByText('Getting this episode')).toBeTruthy();
    expect(screen.getByTestId('episode-fetch-line').props.children).toBe('100 B of 1,000 B');
    expect(screen.queryByTestId('episode-fetch-retry')).toBeNull();
    expect(screen.getByTestId('episode-fetch-cancel')).toBeTruthy();
  });

  it('says how much has come when the size is not known, and that it waits its turn', async () => {
    useEpisodeFetch.setState({ pending: pending({ status: fetchStatus({ bytes_total: null }) }) });
    const r = await render(<EpisodeFetchPanel onClose={jest.fn()} />);
    expect(screen.getByTestId('episode-fetch-line').props.children).toBe('100 B so far');
    await act(async () =>
      useEpisodeFetch.setState({ pending: pending({ status: fetchStatus({ state: 'queued' }) }) }),
    );
    await r.rerender(<EpisodeFetchPanel onClose={jest.fn()} />);
    expect(screen.getByText('Waiting for its turn')).toBeTruthy();
  });

  it("says why it stopped, in the listener's words, and offers Try again", async () => {
    useEpisodeFetch.setState({
      pending: pending({ phase: 'failed', status: wire2b.failed, code: 'too_large' }),
    });
    await render(<EpisodeFetchPanel onClose={jest.fn()} />);
    expect(screen.getByText("Couldn't get this episode")).toBeTruthy();
    expect(screen.getByText('This episode is too large for your server to keep.')).toBeTruthy();
    expect(screen.queryByText('The episode exceeds the size limit.')).toBeNull();
    await fireEvent.press(screen.getByTestId('episode-fetch-retry'));
    expect(mockRetry).toHaveBeenCalledTimes(1);
  });

  it('reads an unknown code with the generic sentence', async () => {
    useEpisodeFetch.setState({ pending: pending({ phase: 'unavailable', code: 'http_404' }) });
    await render(<EpisodeFetchPanel onClose={jest.fn()} />);
    expect(screen.getByText("This episode can't be fetched now")).toBeTruthy();
    expect(screen.getByText('Something went wrong getting it. Try again in a while.')).toBeTruthy();
  });

  it('cancels and closes', async () => {
    const onClose = jest.fn();
    useEpisodeFetch.setState({ pending: pending() });
    await render(<EpisodeFetchPanel onClose={onClose} />);
    await fireEvent.press(screen.getByTestId('episode-fetch-cancel'));
    expect(mockCancel).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('EpisodeFetchStrip', () => {
  it('renders nothing while no fetch is on its way', async () => {
    await render(<EpisodeFetchStrip />);
    expect(screen.queryByTestId('episode-fetch-strip')).toBeNull();
  });

  it('shows the fetch with Cancel, and Try again once it stopped', async () => {
    useEpisodeFetch.setState({ pending: pending() });
    const r = await render(<EpisodeFetchStrip />);
    expect(screen.getByText('Monday')).toBeTruthy();
    expect(screen.getByText('100 B of 1,000 B')).toBeTruthy();
    expect(screen.queryByTestId('episode-fetch-strip-retry')).toBeNull();
    await fireEvent.press(screen.getByTestId('episode-fetch-strip-cancel'));
    expect(mockCancel).toHaveBeenCalledTimes(1);

    await act(async () =>
      useEpisodeFetch.setState({ pending: pending({ phase: 'refused', code: 'fetch_limit' }) }),
    );
    await r.rerender(<EpisodeFetchStrip />);
    await fireEvent.press(screen.getByTestId('episode-fetch-strip-retry'));
    expect(mockRetry).toHaveBeenCalledTimes(1);
  });
});
