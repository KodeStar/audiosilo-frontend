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
  loadingBook?: string | null;
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
    selectBookKey: (s: MockPlayer) =>
      s.nowPlaying
        ? `${s.nowPlaying.connectionId}|${s.nowPlaying.libraryId}|${s.nowPlaying.path}`
        : null,
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

import { KidsPlayer, kidsPlayerLayout } from './kids-player';
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
    loadingBook: null,
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
  await render(<KidsPlayer width={368} />);
  expect(screen.queryByTestId('kids-player')).toBeNull();
});

it('shows the title, the chapter with the minutes left in it, and the progress through it', async () => {
  await render(<KidsPlayer width={368} />);
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
  await render(<KidsPlayer width={368} />);
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
  await render(<KidsPlayer width={368} />);
  expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();

  await act(async () =>
    player.setState({ snapshot: { state: 'error', trackIndex: 0, position: 900, duration: 3600 } }),
  );
  await press('Try again');
  expect(player.getState().retry).toHaveBeenCalledTimes(1);
  expect(player.getState().toggle).not.toHaveBeenCalled();
});

it('shows the spinner while the story loads in, not a play button over a story on its way (D2)', async () => {
  // The previous book was stopped (`idle`) and this one is still loading into the engine.
  player.setState({
    snapshot: { state: 'idle', trackIndex: 0, position: 0, duration: 0 },
    loadingBook: 'c|1|kids/robot',
  });
  await render(<KidsPlayer width={368} />);
  expect(screen.getByTestId('kids-play').props.accessibilityState?.busy).toBe(true);

  // Loaded: the engine's own state again (another book loading in is not this one's).
  await act(async () => player.setState({ loadingBook: 'c|1|kids/other' }));
  expect(screen.getByTestId('kids-play').props.accessibilityState?.busy).toBeFalsy();
  expect(screen.getByRole('button', { name: 'Play' })).toBeTruthy();
});

it('lays out by the measured width, never under the kids minimum', () => {
  // A desktop or landscape tablet: the cover beside big controls.
  expect(kidsPlayerLayout(1000)).toMatchObject({ beside: true, play: 120, button: 84 });
  // A portrait tablet: big controls under the cover (they don't fit beside it).
  expect(kidsPlayerLayout(568)).toMatchObject({ beside: false, play: 120, button: 84 });
  // A phone, and the first render before the column is measured.
  expect(kidsPlayerLayout(368)).toMatchObject({ beside: false, play: 104, button: 72 });
  expect(kidsPlayerLayout(0)).toMatchObject({ beside: false, play: 104, button: 72 });
  // A 360 dp Android phone: shrunk to fit one row, still at least 64 pt.
  const narrow = kidsPlayerLayout(328);
  expect(narrow.button).toBeGreaterThanOrEqual(64);
  expect(narrow.play).toBeGreaterThanOrEqual(88);
  expect(3 * narrow.button + narrow.play + 3 * narrow.gap).toBeLessThanOrEqual(328);
  for (const w of [0, 300, 328, 368, 500, 568, 800, 1200]) {
    const l = kidsPlayerLayout(w);
    // The row fits its column (beside: the column next to the cover).
    const column = l.beside ? w - l.cover - 40 : w;
    if (w >= 328) expect(3 * l.button + l.play + 3 * l.gap).toBeLessThanOrEqual(column);
  }
});
