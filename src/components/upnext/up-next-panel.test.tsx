import { fireEvent, render, screen } from '@testing-library/react-native';

import type { Book, QueueEntry } from '@/api/types';

jest.mock('react-native-gesture-handler', () => ({
  ...jest.requireActual('react-native-gesture-handler'),
  GestureDetector: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@/components/library/book-cover', () => ({ BookCover: () => null }));
jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));
jest.mock('@/api/hooks', () => ({
  useBook: (_lib: number, path: string) => ({ data: { title: `Title of ${path}` } }),
}));
const mockQueue = jest.fn();
const mockUnqueue = jest.fn();
jest.mock('@/components/library/use-queue-actions', () => ({
  useQueueActions: () => ({ queue: mockQueue, unqueue: mockUnqueue }),
}));
jest.mock('./use-up-next', () => ({ usePlayNow: () => jest.fn() }));
const mockPush = jest.fn();
jest.mock('expo-router', () => ({ router: { push: (h: unknown) => mockPush(h) } }));
jest.mock('@/playback/store', () => {
  const { create } = jest.requireActual('zustand');
  return {
    usePlayer: create(() => ({ nowPlaying: null })),
    selectCurrentChapter: () => null,
    selectIsPlaying: () => false,
  };
});

/* eslint-disable import/first */
import { useSession } from '@/stores/session';
import { useSettings } from '@/stores/settings';

import { UpNextPanel } from './up-next-panel';
import { progressIndex } from './up-next-model';
/* eslint-enable import/first */

type Data = Parameters<typeof UpNextPanel>[0]['data'];
const entry = (path: string): QueueEntry => ({
  library_id: 1,
  path,
  added_at: '2026-10-06T10:00:00Z',
  book: { title: path, series: '', series_index: 0, author: 'A', duration: 60 } as Book,
});
const data = (over: Partial<Data> = {}): Data => ({
  entries: [],
  isLoading: false,
  error: null,
  refetch: jest.fn(),
  progress: progressIndex([]),
  queuedSeconds: 0,
  suggestions: [],
  move: jest.fn(),
  clear: jest.fn(),
  dropPlayed: jest.fn(),
  busy: false,
  ...over,
});

beforeEach(() => {
  useSession.setState({
    connections: [{ id: 'c', name: 'Home Library' }] as never,
    defaultConnectionId: 'c',
  });
  mockPush.mockReset();
  mockQueue.mockReset();
});

describe('UpNextPanel', () => {
  it('shows cover-shaped placeholders while the queue loads', async () => {
    await render(<UpNextPanel cid="c" data={data({ entries: undefined, isLoading: true })} />);
    expect(screen.getByTestId('upnext-skeleton')).toBeTruthy();
  });

  it('says when the queue could not load, with Retry', async () => {
    const d = data({ entries: undefined, error: new Error('x') });
    await render(<UpNextPanel cid="c" data={d} />);
    expect(screen.getByText("Couldn't load Up next.")).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
    expect(d.refetch).toHaveBeenCalled();
  });

  it('keeps the list on screen when a refresh fails', async () => {
    await render(
      <UpNextPanel cid="c" data={data({ entries: [entry('Kept')], error: new Error('x') })} />,
    );
    expect(screen.getByText('Kept')).toBeTruthy();
    expect(screen.getByText(/Couldn't refresh Up next/)).toBeTruthy();
  });

  it('has an empty state (no drop zone off the web desktop)', async () => {
    await render(<UpNextPanel cid="c" data={data()} />);
    expect(screen.getByText('Nothing queued yet')).toBeTruthy();
    expect(screen.queryByText('Clear')).toBeNull();
  });

  it('clears the visible entries in one go', async () => {
    const entries = [entry('One'), entry('Two')];
    const d = data({ entries });
    await render(<UpNextPanel cid="c" data={d} />);
    expect(screen.getByText('Up next · 2')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Clear Up next' }));
    expect(d.clear).toHaveBeenCalledWith(entries);
  });

  it('suggests books to queue and a ghost for the next work this server lacks', async () => {
    const onNavigate = jest.fn();
    await render(
      <UpNextPanel
        cid="c"
        onNavigate={onNavigate}
        data={data({
          suggestions: [
            { kind: 'next', ref: { library_id: 1, path: 'S/2' }, series: 'Saga' },
            { kind: 'progress', ref: { library_id: 1, path: 'P' }, percent: 40 },
            { kind: 'ghost', title: 'Book Three', position: '3', workId: 'w3' },
          ],
        })}
      />,
    );
    expect(screen.getByText('Continue the series and more')).toBeTruthy();
    expect(screen.getByText('Next in Saga')).toBeTruthy();
    expect(screen.getByText('40% · continue')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Add Title of S/2 to Up next' }));
    expect(mockQueue).toHaveBeenCalledWith(1, 'S/2');
    // No book is loaded, so there is no library to open the series in.
    expect(screen.getByText("Book Three isn't on Home Library")).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Title of P, 40% · continue' }));
    expect(onNavigate).toHaveBeenCalled();
    expect(mockPush).toHaveBeenCalled();
  });

  it('labels the auto-play switch for what it does today', async () => {
    useSettings.setState({ autoPlayNext: false });
    await render(<UpNextPanel cid="c" data={data()} />);
    const sw = screen.getByLabelText('Play the next book in the series automatically');
    await fireEvent.press(sw);
    expect(useSettings.getState().autoPlayNext).toBe(true);
  });
});
