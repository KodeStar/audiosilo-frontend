import { fireEvent, render, screen } from '@testing-library/react-native';

const mockOpenBook = jest.fn();
jest.mock('@/lib/open', () => ({ useOpen: () => ({ openBook: mockOpenBook }) }));
const mockPlay = jest.fn();
jest.mock('@/components/player/use-play-book', () => ({ usePlayBook: () => mockPlay }));
const mockRequest = jest.fn();
jest.mock('@/playback/episode-fetch', () => ({
  requestEpisodeFetch: (...a: unknown[]) => mockRequest(...a),
}));
const mockActions = jest.fn();
jest.mock('@/components/library/books/book-actions', () => ({
  BookActionsButton: (p: unknown) => {
    mockActions(p);
    return null;
  },
}));

/* eslint-disable import/first */
import type { PodcastEpisode, Progress } from '@/api/types';
import { fetchStatus, podcastEpisode, podcastShow, wire2b } from '@/testing/podcast-fixtures';

import { EpisodeRow } from './episode-row';
/* eslint-enable import/first */

const now = new Date('2026-10-22T12:00:00Z');
const renderRow = (
  episode: PodcastEpisode,
  extra: { progress?: Progress; canFetch?: boolean; pending?: object | null } = {},
) =>
  render(
    <EpisodeRow
      connectionId="c1"
      show={podcastShow()}
      episode={episode}
      progress={extra.progress}
      pending={(extra.pending ?? null) as never}
      canFetch={extra.canFetch ?? true}
      now={now}
    />,
  );

beforeEach(() => {
  mockOpenBook.mockReset();
  mockPlay.mockReset().mockResolvedValue(undefined);
  mockRequest.mockReset();
  mockActions.mockReset();
});

describe('EpisodeRow', () => {
  it('says where the file is', async () => {
    await renderRow(podcastEpisode());
    expect(screen.getByTestId('episode-state').props.children).toBe('Ready on your server');
    await renderRow(podcastEpisode({ downloaded: false }));
    expect(screen.getByTestId('episode-state').props.children).toBe('Plays on demand');
    await renderRow(podcastEpisode({ downloaded: false, fetch: wire2b.status_response.fetch }));
    expect(screen.getByTestId('episode-state').props.children).toBe('Getting it 10%');
    await renderRow(
      podcastEpisode({
        downloaded: false,
        fetch: fetchStatus({ state: 'queued', bytes_total: null }),
      }),
    );
    expect(screen.getByTestId('episode-state').props.children).toBe('Getting it');
    await renderRow(podcastEpisode({ downloaded: false }), { canFetch: false });
    expect(screen.getByTestId('episode-state').props.children).toBe('Not available now');
  });

  it('plays through the normal start, and opens the episode page', async () => {
    const ep = podcastEpisode({ downloaded: false });
    await renderRow(ep);
    await fireEvent.press(screen.getByTestId('episode-play'));
    expect(mockPlay).toHaveBeenCalledWith({ connectionId: 'c1', libraryId: 5, path: ep.path });
    await fireEvent.press(screen.getByText('Monday'));
    expect(mockOpenBook).toHaveBeenCalledWith('c1', 5, ep.path);
  });

  it('offers Try again after a failed fetch, asking the server again', async () => {
    const ep = podcastEpisode({ downloaded: false, fetch: wire2b.failed });
    await renderRow(ep);
    expect(screen.getByTestId('episode-state').props.children).toBe("Couldn't get it");
    expect(screen.queryByTestId('episode-play')).toBeNull();
    await fireEvent.press(screen.getByTestId('episode-retry'));
    expect(mockRequest).toHaveBeenCalledWith(
      { connectionId: 'c1', libraryId: 5, path: ep.path },
      expect.objectContaining({ rel_path: ep.path }),
      {},
      { retry: true },
    );
  });

  it('marks trailers, bonus and explicit episodes, and one gone from the feed', async () => {
    await renderRow(podcastEpisode({ episode_type: 'trailer', explicit: true, removed: true }));
    expect(screen.getByText('Trailer')).toBeTruthy();
    expect(screen.getByText('Explicit')).toBeTruthy();
    expect(screen.getByText('No longer in the feed')).toBeTruthy();
    await renderRow(podcastEpisode({ episode_type: 'bonus' }));
    expect(screen.getByText('Bonus')).toBeTruthy();
  });

  it('says Resume once started and Finished once done', async () => {
    const progress = (over: Partial<Progress>) =>
      ({ position: 600, duration: 1800, finished: false, ...over }) as Progress;
    await renderRow(podcastEpisode(), { progress: progress({}) });
    expect(screen.getByText('Resume')).toBeTruthy();
    await renderRow(podcastEpisode(), { progress: progress({ finished: true }) });
    expect(screen.getByTestId('episode-finished')).toBeTruthy();
  });

  it('offers Up next and Mark as finished, never a download', async () => {
    await renderRow(podcastEpisode());
    // The actions drop Download for any book with `episode` set (`useBookActions`).
    expect(mockActions).toHaveBeenCalledWith(
      expect.objectContaining({
        omit: ['play', 'collect', 'series'],
        book: expect.objectContaining({ episode: expect.anything() }),
      }),
    );
  });
});
