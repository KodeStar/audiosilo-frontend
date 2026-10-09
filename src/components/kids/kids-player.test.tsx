import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { StoreApi, UseBoundStore } from 'zustand';

type Chapter = {
  index: number;
  title: string;
  start: number;
  end: number;
  book_offset: number;
};
type MockPlayer = {
  nowPlaying: {
    connectionId: string;
    libraryId: number;
    path: string;
    title: string;
    author: string;
    queue: { total: number; chapters: Chapter[]; offsets: number[] };
  } | null;
  snapshot: { state: string; trackIndex: number; position: number; duration: number };
  rate: number;
  toggle: jest.Mock;
  retry: jest.Mock;
  skipSeconds: jest.Mock;
  seekBook: jest.Mock;
  seekInTrack: jest.Mock;
  goToTrack: jest.Mock;
};
jest.mock('@/playback/store', () => {
  const { create } = jest.requireActual('zustand');
  const position = (s: MockPlayer) => s.snapshot.position;
  return {
    usePlayer: create(() => ({})),
    selectIsPlaying: (s: MockPlayer) => s.snapshot.state === 'playing',
    selectBookPosition: position,
    selectCurrentChapter: (s: MockPlayer) =>
      [...(s.nowPlaying?.queue.chapters ?? [])]
        .reverse()
        .find((c) => c.book_offset <= position(s)) ?? null,
  };
});
jest.mock('@/components/library/book-cover', () => ({ BookCover: () => null }));

/* eslint-disable import/first */
import { usePlayer } from '@/playback/store';

import { KidsPlayer, kidsPlayerSizes } from './kids-player';
/* eslint-enable import/first */

const player = usePlayer as unknown as UseBoundStore<StoreApi<MockPlayer>>;

const chapter = (index: number, offset: number, length: number): Chapter => ({
  index,
  title: ['The Start', 'The Middle', 'The End'][index],
  start: 0,
  end: length,
  book_offset: offset,
});

beforeEach(() => {
  player.setState({
    nowPlaying: {
      connectionId: 'c',
      libraryId: 1,
      path: 'kids/robot',
      title: 'The Wild Robot',
      author: 'Peter Brown',
      queue: {
        total: 3600,
        chapters: [chapter(0, 0, 600), chapter(1, 600, 1200), chapter(2, 1800, 1800)],
        offsets: [0],
      },
    },
    snapshot: { state: 'paused', trackIndex: 0, position: 900, duration: 3600 },
    rate: 1,
    toggle: jest.fn(),
    retry: jest.fn(),
    skipSeconds: jest.fn(),
    seekBook: jest.fn(),
    seekInTrack: jest.fn(),
    goToTrack: jest.fn(),
  });
});

const press = (name: string) => fireEvent.press(screen.getByRole('button', { name }));

it('renders nothing with no story loaded', async () => {
  player.setState({ nowPlaying: null });
  await render(<KidsPlayer wide={false} width={368} />);
  expect(screen.queryByTestId('kids-player')).toBeNull();
});

it('shows the title, the chapter with the minutes left in it, and the progress through it', async () => {
  await render(<KidsPlayer wide={false} width={368} />);
  expect(screen.getByText('The Wild Robot')).toBeTruthy();
  // 300 s into a 1200 s chapter: 900 s (15 minutes) left.
  expect(screen.getByTestId('kids-chapter')).toHaveTextContent('The Middle · 15 minutes left');
  expect(screen.getByTestId('kids-progress').props.accessibilityValue).toEqual({
    min: 0,
    max: 100,
    now: 25,
  });
});

it('has exactly the four big controls, and they drive the player', async () => {
  await render(<KidsPlayer wide={false} width={368} />);
  expect(screen.getAllByRole('button')).toHaveLength(4);
  const s = player.getState();
  await press('Play');
  expect(s.toggle).toHaveBeenCalledTimes(1);
  await press('Go back 30 seconds');
  expect(s.skipSeconds).toHaveBeenLastCalledWith(-30);
  await press('Next chapter');
  expect(s.seekBook).toHaveBeenLastCalledWith(1800); // the next chapter's start
  await press('Previous chapter');
  expect(s.seekBook).toHaveBeenLastCalledWith(600); // the start of this chapter
  // Nothing to scrub with: the progress line is not adjustable.
  expect(screen.getByTestId('kids-progress').props.accessibilityRole).toBe('progressbar');
  expect(screen.queryByRole('adjustable')).toBeNull();
});

it('says Pause while playing, and Try again after an error', async () => {
  player.setState({ snapshot: { state: 'playing', trackIndex: 0, position: 900, duration: 3600 } });
  await render(<KidsPlayer wide={false} width={368} />);
  expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();

  await act(async () =>
    player.setState({ snapshot: { state: 'error', trackIndex: 0, position: 900, duration: 3600 } }),
  );
  await press('Try again');
  expect(player.getState().retry).toHaveBeenCalledTimes(1);
  expect(player.getState().toggle).not.toHaveBeenCalled();
});

it('keeps every control at least 64 pt and fits a narrow phone in one row', () => {
  expect(kidsPlayerSizes(true, 900)).toMatchObject({ play: 120, button: 84 });
  expect(kidsPlayerSizes(false, 368)).toMatchObject({ play: 104, button: 72 });
  const narrow = kidsPlayerSizes(false, 328); // a 360 dp Android phone
  expect(narrow.button).toBeGreaterThanOrEqual(64);
  expect(narrow.play).toBeGreaterThanOrEqual(88);
  expect(3 * narrow.button + narrow.play + 3 * narrow.gap).toBeLessThanOrEqual(328);
});
