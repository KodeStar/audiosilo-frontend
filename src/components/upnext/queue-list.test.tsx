import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';

import type { Book, QueueEntry } from '@/api/types';

// The drag is gesture-handler + reanimated on the UI thread; this suite covers the
// keyboard and screen-reader paths, so the detector just renders.
jest.mock('react-native-gesture-handler', () => ({
  ...jest.requireActual('react-native-gesture-handler'),
  GestureDetector: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@/components/library/book-cover', () => ({ BookCover: () => null }));
jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));
const mockPush = jest.fn();
jest.mock('expo-router', () => ({ router: { push: (h: unknown) => mockPush(h) } }));

/* eslint-disable import/first */
import { entryCaption, QueueList } from './queue-list';
import { progressIndex } from './up-next-model';
/* eslint-enable import/first */

const t = ((key: string, o?: Record<string, unknown>) =>
  key === 'upnext.percent'
    ? `${o?.percent}%`
    : key === 'upnext.finished'
      ? 'Finished'
      : key) as never;

const entry = (path: string, book?: Partial<Book>): QueueEntry => ({
  library_id: 1,
  path,
  added_at: '2026-10-06T10:00:00Z',
  book: book
    ? ({ series: '', series_index: 0, author: '', duration: 0, ...book } as Book)
    : undefined,
});

describe('entryCaption', () => {
  it('names the series and number (or the author), then the place or the length', () => {
    const none = progressIndex([]);
    expect(
      entryCaption(entry('A', { series: 'The Expanse', series_index: 5, duration: 8100 }), none, t),
    ).toBe('The Expanse · 5 · 2h 15m');
    expect(entryCaption(entry('B', { author: 'Andy Weir', duration: 600 }), none, t)).toBe(
      'Andy Weir · 10m',
    );
    const index = progressIndex([
      { library_id: 1, path: 'C', position: 55, duration: 100, finished: false },
      { library_id: 1, path: 'D', position: 100, duration: 100, finished: true },
    ]);
    expect(entryCaption(entry('C', { author: 'X' }), index, t)).toBe('X · 55%');
    expect(entryCaption(entry('D', { series: 'S' }), index, t)).toBe('S · Finished');
    expect(entryCaption(entry('E'), none, t)).toBe('');
  });
});

describe('QueueList', () => {
  const entries = [
    entry('Dir/A', { title: 'Alpha' }),
    entry('Dir/B', { title: 'Beta' }),
    entry('Dir/C', { title: 'Gamma' }),
  ];
  const setup = async () => {
    const onMove = jest.fn().mockResolvedValue(true);
    const onRemove = jest.fn();
    const onPlay = jest.fn();
    await render(
      <QueueList
        entries={entries}
        progress={progressIndex([])}
        connectionId="c"
        onMove={onMove}
        onRemove={onRemove}
        onPlay={onPlay}
      />,
    );
    return { onMove, onRemove, onPlay };
  };
  const titles = () => screen.getAllByText(/^(Alpha|Beta|Gamma)$/).map((n) => n.props.children);
  const os = Platform.OS;
  afterEach(() => {
    Platform.OS = os;
  });

  it('plays, removes and opens a row', async () => {
    const { onRemove, onPlay } = await setup();
    await fireEvent.press(screen.getByLabelText('Play Beta now'));
    expect(onPlay).toHaveBeenCalledWith(entries[1]);
    await fireEvent.press(screen.getByLabelText('Remove Gamma from Up next'));
    expect(onRemove).toHaveBeenCalledWith(entries[2]);
    await fireEvent.press(screen.getByRole('button', { name: /^Alpha/ }));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/book/[libraryId]',
      params: { libraryId: '1', connection: 'c', path: 'Dir/A' },
    });
  });

  it('moves a row with the arrow keys on its grip (web), showing the new order at once', async () => {
    Platform.OS = 'web';
    const { onMove } = await setup();
    const key = (k: string, altKey = false) => ({
      key: k,
      altKey,
      preventDefault: jest.fn(),
      stopPropagation: jest.fn(),
    });
    await act(async () => {
      fireEvent(screen.getByLabelText('Reorder Alpha'), 'keyDown', key('ArrowDown'));
    });
    expect(onMove).toHaveBeenCalledWith(entries[0], 1);
    expect(titles()).toEqual(['Beta', 'Alpha', 'Gamma']);
    // Up at the top does nothing.
    await act(async () => {
      fireEvent(screen.getByLabelText('Reorder Beta'), 'keyDown', key('ArrowUp'));
    });
    expect(onMove).toHaveBeenCalledTimes(1);
    // Other keys do nothing, even with Alt.
    await act(async () => {
      fireEvent(screen.getByLabelText('Reorder Gamma'), 'keyDown', key('Enter', true));
    });
    expect(onMove).toHaveBeenCalledTimes(1);
  });

  it('offers screen readers Move up and Move down on the grip', async () => {
    const { onMove } = await setup();
    const grip = screen.getByLabelText('Reorder Beta');
    expect(grip.props.accessibilityActions.map((a: { name: string }) => a.name)).toEqual([
      'moveUp',
      'moveDown',
    ]);
    expect(
      screen
        .getByLabelText('Reorder Alpha')
        .props.accessibilityActions.map((a: { name: string }) => a.name),
    ).toEqual(['moveDown']);
    await act(async () => {
      fireEvent(grip, 'accessibilityAction', { nativeEvent: { actionName: 'moveUp' } });
    });
    expect(onMove).toHaveBeenCalledWith(entries[1], 0);
    expect(titles()).toEqual(['Beta', 'Alpha', 'Gamma']);
  });

  it('goes back to the stored order when a move fails', async () => {
    const { onMove } = await setup();
    onMove.mockResolvedValueOnce(false);
    await act(async () => {
      fireEvent(screen.getByLabelText('Reorder Gamma'), 'accessibilityAction', {
        nativeEvent: { actionName: 'moveUp' },
      });
    });
    expect(titles()).toEqual(['Alpha', 'Beta', 'Gamma']);
  });
});
