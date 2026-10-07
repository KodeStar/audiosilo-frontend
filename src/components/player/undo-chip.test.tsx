import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { useReducedMotion } from 'react-native-reanimated';

import type { PlayerStoreMock } from '@/testing/player-store-mock';

jest.mock('@/playback/store', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/testing/player-store-mock').createPlayerStoreMock(),
);
jest.mock('@/components/ui/toast', () => ({ toast: jest.fn() }));

/* eslint-disable import/first */
import { toast } from '@/components/ui/toast';
import { UNDO_WINDOW_MS, useJumpUndo } from '@/playback/jump-undo';
import { playerStoreMock } from '@/testing/player-store-mock';

import { UndoChip } from './undo-chip';
/* eslint-enable import/first */

const BOOK = {
  connectionId: 'srv',
  libraryId: 1,
  path: 'a/book',
  queue: { chapters: [], total: 99_999 },
};
const KEY = 'srv:1:a/book';
let player: PlayerStoreMock;
const seekBook = jest.fn(() => Promise.resolve());

beforeEach(() => {
  jest.useFakeTimers({ now: new Date('2026-10-07T21:00:00Z') });
  player = playerStoreMock();
  player.reset();
  player.usePlayer.setState({ nowPlaying: BOOK, seekBook } as never);
  seekBook.mockClear();
  (toast as jest.Mock).mockClear();
  useJumpUndo.setState({ jump: null });
});
afterEach(() => {
  jest.useRealTimers();
});

const offer = (from: number, bookKey = KEY) =>
  useJumpUndo.setState({
    jump: { from, bookKey, at: Date.now(), until: Date.now() + UNDO_WINDOW_MS },
  });

describe('UndoChip', () => {
  it('renders nothing without an undo', async () => {
    await render(<UndoChip />);
    expect(screen.toJSON()).toBeNull();
  });

  it('renders nothing for another book', async () => {
    offer(62_810, 'srv:1:a/other');
    await render(<UndoChip />);
    expect(screen.toJSON()).toBeNull();
  });

  it('offers to go back to where the listener was, by the book clock', async () => {
    offer(62_810);
    await render(<UndoChip />);
    expect(screen.getByRole('button', { name: 'Back to 17:26:50' })).toBeTruthy();
    expect(screen.getByText('Back to 17:26:50')).toBeTruthy();
  });

  it('goes back on a press, says so, and goes away', async () => {
    offer(62_810);
    await render(<UndoChip />);
    await fireEvent.press(screen.getByRole('button', { name: 'Back to 17:26:50' }));
    expect(seekBook).toHaveBeenCalledWith(62_810);
    expect(toast).toHaveBeenCalledWith({
      title: 'Back where you were',
      description: '17:26:50',
    });
    expect(screen.toJSON()).toBeNull();
  });

  it('appears and disappears with the store', async () => {
    await render(<UndoChip />);
    await act(async () => offer(600));
    expect(screen.getByRole('button', { name: 'Back to 10:00' })).toBeTruthy();
    await act(async () => useJumpUndo.setState({ jump: null }));
    expect(screen.toJSON()).toBeNull();
  });

  it('still renders with reduced motion (a still ring)', async () => {
    (useReducedMotion as jest.Mock).mockReturnValue(true);
    offer(600);
    await render(<UndoChip />);
    expect(screen.getByRole('button', { name: 'Back to 10:00' })).toBeTruthy();
    (useReducedMotion as jest.Mock).mockReturnValue(false);
  });
});
