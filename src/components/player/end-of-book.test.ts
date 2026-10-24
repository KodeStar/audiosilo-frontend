import type { QueueEntry } from '@/api/types';
import type { UpNextBook } from '@/playback/up-next-resolver';

const mockRemove = jest.fn();
jest.mock('@/api/hooks', () => ({
  ...jest.requireActual('@/api/hooks'),
  removeFromQueue: (cid: string, _client: unknown, v: unknown) => mockRemove(cid, v),
}));
jest.mock('@/api/provider', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/testing/api-provider-mock').apiProviderMock({}),
);
const mockQueueRead = jest.fn();
let mockClient: object | null;
jest.mock('@/api/connection-clients', () => ({ resolveClient: () => mockClient }));
const mockStart = jest.fn();
jest.mock('./start-book', () => ({ startBookInPlace: (t: unknown) => mockStart(t) }));

/* eslint-disable import/first */
import { qk } from '@/api/hooks';
import { queryClient } from '@/api/provider';
import { contentKeyOf } from '@/lib/content-key';
import { type PendingEpisodeFetch, useEpisodeFetch } from '@/playback/episode-fetch';

import { advanceTo } from './end-of-book';
/* eslint-enable import/first */

const entry = (path: string): QueueEntry => ({ library_id: 1, path, added_at: '' });
const next: UpNextBook = {
  connectionId: 'c1',
  libraryId: 1,
  path: 'Other/Queued',
  title: 'Queued',
  author: '',
  duration: 0,
  source: 'queue',
  queueEntry: { library_id: 1, path: 'Other/Queued' },
};

beforeEach(() => {
  queryClient.clear();
  queryClient.setQueryDefaults(qk.queue('c1'), { gcTime: Infinity });
  queryClient.setQueryDefaults(qk.server('c1'), { gcTime: Infinity });
  queryClient.setQueryData(qk.server('c1'), { capabilities: { queue: true } });
  mockClient = { queue: () => mockQueueRead() };
  mockQueueRead.mockReset().mockResolvedValue([entry('Series/Book 1')]);
  mockRemove.mockReset().mockResolvedValue(undefined);
  mockStart.mockReset().mockResolvedValue(true);
  useEpisodeFetch.setState({ pending: null });
});

/** What the episode fetch holds once a start handed `of` to it (frontend#122). */
function fetchOf(of: UpNextBook, phase: PendingEpisodeFetch['phase']): PendingEpisodeFetch {
  return {
    key: contentKeyOf(of),
    target: of,
    title: of.title,
    show: 'Show',
    opts: {},
    phase,
    status: null,
    code: null,
  };
}

describe('advanceTo', () => {
  it('starts the next book in place, then takes it off Up next', async () => {
    queryClient.setQueryData(qk.queue('c1'), [entry('Other/Queued'), entry('Series/Book 1')]);
    await expect(advanceTo(next)).resolves.toBe(true);
    expect(mockStart).toHaveBeenCalledWith(next);
    await new Promise((r) => setTimeout(r, 0));
    expect(mockRemove.mock.calls).toEqual([['c1', { libraryId: 1, path: 'Other/Queued' }]]);
  });

  it('leaves Up next alone when the book does not start', async () => {
    queryClient.setQueryData(qk.queue('c1'), [entry('Other/Queued'), entry('Series/Book 1')]);
    mockStart.mockResolvedValueOnce(false);
    await expect(advanceTo(next)).resolves.toBe(false);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockStart.mockRejectedValueOnce(new Error('offline'));
    await expect(advanceTo(next)).resolves.toBe(false);
    warn.mockRestore();
    await new Promise((r) => setTimeout(r, 0));
    expect(mockRemove).not.toHaveBeenCalled();
  });

  // frontend#122: an episode still to be fetched is on its way, not playing: it stays next.
  it('keeps a queued episode on Up next while its fetch is on its way', async () => {
    const episode: UpNextBook = {
      ...next,
      path: 'Shows/Daily/Ep 9',
      queueEntry: { library_id: 1, path: 'Shows/Daily/Ep 9' },
    };
    queryClient.setQueryData(qk.queue('c1'), [entry('Shows/Daily/Ep 9')]);
    mockStart.mockImplementationOnce(async () => {
      useEpisodeFetch.setState({ pending: fetchOf(episode, 'probing') });
      return true;
    });
    await expect(advanceTo(episode)).resolves.toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(mockRemove).not.toHaveBeenCalled();
    // The fetch fails: it is still the head of Up next.
    useEpisodeFetch.setState({ pending: fetchOf(episode, 'failed') });
    await new Promise((r) => setTimeout(r, 0));
    expect(mockRemove).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(qk.queue('c1'))).toEqual([entry('Shows/Daily/Ep 9')]);
  });

  it('still takes a started book off Up next while a fetch of something else is pending', async () => {
    queryClient.setQueryData(qk.queue('c1'), [entry('Other/Queued')]);
    useEpisodeFetch.setState({
      pending: fetchOf({ ...next, path: 'Shows/Daily/Ep 1' }, 'waiting'),
    });
    await expect(advanceTo(next)).resolves.toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(mockRemove.mock.calls).toEqual([['c1', { libraryId: 1, path: 'Other/Queued' }]]);
  });
});
