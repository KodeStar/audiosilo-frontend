import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';
import type { StoreApi, UseBoundStore } from 'zustand';

// The gestures run on the UI thread (no jest runtime for that): the detector just renders
// its child and records the gesture, so a test can call its handlers directly, and its
// web touch-action.
const mockGestures: unknown[] = [];
const mockTouchActions: unknown[] = [];
jest.mock('react-native-gesture-handler', () => ({
  ...jest.requireActual('react-native-gesture-handler'),
  GestureDetector: ({
    children,
    gesture,
    touchAction,
  }: {
    children: React.ReactNode;
    gesture: unknown;
    touchAction?: string;
  }) => {
    mockGestures.push(gesture);
    mockTouchActions.push(touchAction);
    return children;
  },
}));

type Chapter = { index: number; title: string; start: number; end: number; book_offset: number };
type MockPlayer = {
  nowPlaying: { queue: { total: number } } | null;
  bookPosition: number;
  chapter: Chapter | null;
  snapshot: { trackIndex: number; position: number; duration: number };
  rate: number;
  seekBook: jest.Mock;
  seekInTrack: jest.Mock;
  skipSeconds: jest.Mock;
};
jest.mock('@/playback/store', () => {
  const { create } = jest.requireActual('zustand');
  const usePlayer = create(() => ({}));
  return {
    usePlayer,
    selectBookKey: (s: MockPlayer) => (s.nowPlaying ? 'srv:1:a/book' : null),
    selectBookPosition: (s: MockPlayer) => s.bookPosition,
    selectCurrentChapter: (s: MockPlayer) => s.chapter,
  };
});

/* eslint-disable import/first */
import { formatWallClock } from '@/lib/format';
import { usePlayer } from '@/playback/store';
import { useSettings } from '@/stores/settings';

import { PlayerSeekBar, SeekBar, SeekTimes, seekTextureKey } from './seek-bar';
/* eslint-enable import/first */

const player = usePlayer as unknown as UseBoundStore<StoreApi<MockPlayer>>;

type Handlers = {
  onBegin: (e: { x: number }) => void;
  onUpdate: (e: { x: number }) => void;
  onEnd: (e: { x: number }, success: boolean) => void;
  onFinalize: (e: { x: number }, success: boolean) => void;
};
type Gestures = { toGestureArray: () => { handlers: Handlers }[] };
const lastGesture = () => (mockGestures.at(-1) as Gestures).toGestureArray();

const CHAPTER: Chapter = {
  index: 22,
  title: 'Bridge Four',
  start: 0,
  end: 4668,
  book_offset: 1800,
};

beforeEach(() => {
  mockGestures.length = 0;
  useSettings.setState({ skipForward: 30, skipBackward: 15 });
});

function bar(over: Partial<React.ComponentProps<typeof SeekBar>> = {}) {
  const props = {
    position: 2472, // 41:12
    duration: 4668, // 1:17:48
    textureKey: 'k',
    onSeek: jest.fn(),
    ...over,
  };
  return props;
}

const layout = (width = 350) =>
  fireEvent(screen.getByRole('adjustable'), 'layout', {
    nativeEvent: { layout: { width, height: 58 } },
  });

describe('SeekBar', () => {
  const prevOS = Platform.OS;
  afterEach(() => {
    Platform.OS = prevOS;
  });

  it('is an adjustable "Position in chapter" with a spoken value', async () => {
    await render(<SeekBar {...bar()} />);
    const slider = screen.getByRole('adjustable', { name: 'Position in chapter' });
    expect(slider).toHaveAccessibilityValue({
      min: 0,
      max: 4668,
      now: 2472,
      text: '41:12 of 1:17:48',
    });
  });

  it('steps by the skip lengths with the screen-reader actions', async () => {
    const p = bar();
    await render(<SeekBar {...p} />);
    const slider = screen.getByRole('adjustable');
    await fireEvent(slider, 'accessibilityAction', { nativeEvent: { actionName: 'increment' } });
    expect(p.onSeek).toHaveBeenLastCalledWith(2502);
    await fireEvent(slider, 'accessibilityAction', { nativeEvent: { actionName: 'decrement' } });
    expect(p.onSeek).toHaveBeenLastCalledWith(2457);
  });

  it('hands the steps to onStep when given, also from the web arrow keys', async () => {
    Platform.OS = 'web';
    const onStep = jest.fn();
    const p = bar({ onStep });
    await render(<SeekBar {...p} />);
    const slider = screen.getByRole('adjustable');
    await fireEvent(slider, 'keyDown', { key: 'ArrowRight', preventDefault: jest.fn() });
    await fireEvent(slider, 'keyDown', { key: 'ArrowLeft', preventDefault: jest.fn() });
    expect(onStep.mock.calls).toEqual([[1], [-1]]);
    expect(p.onSeek).not.toHaveBeenCalled();
  });

  it('draws one layer of unplayed and one of played bars, once measured', async () => {
    await render(<SeekBar {...bar()} />);
    expect(screen.queryByTestId('seek-bars')).toBeNull();
    await layout();
    expect(screen.getByTestId('seek-bars')).toBeTruthy();
    expect(screen.getByTestId('seek-bars-played')).toBeTruthy();
    // The hovered layer is web-only, and only while hovering.
    expect(screen.queryByTestId('seek-bars-hovered')).toBeNull();
  });

  it('puts a bookmark glyph above each bookmark inside the segment', async () => {
    await render(<SeekBar {...bar({ bookmarks: [100, 2000, 99_999] })} />);
    await layout();
    // The third is outside the segment.
    expect(screen.getAllByTestId('seek-bookmark')).toHaveLength(2);
  });

  it('previews a drag with a tip in the chapter and the book, and commits on release', async () => {
    const p = bar({ bookOffset: 60_000, onScrub: jest.fn() });
    await render(<SeekBar {...p} />);
    await layout(400);
    const [pan] = lastGesture();
    await act(async () => pan.handlers.onBegin({ x: 200 }));
    // Half of 1:17:48.
    expect(p.onScrub).toHaveBeenLastCalledWith(2334);
    expect(screen.getByText('38:54')).toBeTruthy();
    expect(screen.getByText('17:18:54 in the book')).toBeTruthy();
    await act(async () => pan.handlers.onEnd({ x: 200 }, true));
    expect(p.onSeek).toHaveBeenLastCalledWith(2334);
    await act(async () => pan.handlers.onFinalize({ x: 200 }, true));
    expect(p.onScrub).toHaveBeenLastCalledWith(null);
    expect(screen.queryByText('38:54')).toBeNull();
  });

  it('shades the hovered bars and offers a jump on the web', async () => {
    Platform.OS = 'web';
    await render(<SeekBar {...bar()} />);
    await layout(400);
    const slider = screen.getByRole('adjustable');
    const rect = { getBoundingClientRect: () => ({ left: 0, width: 400 }) };
    await fireEvent(slider, 'pointerMove', { nativeEvent: { clientX: 300 }, currentTarget: rect });
    expect(screen.getByTestId('seek-bars-hovered')).toBeTruthy();
    // Three quarters of 1:17:48.
    expect(screen.getByText('58:21')).toBeTruthy();
    expect(screen.getByText('Click to jump')).toBeTruthy();
    await fireEvent(slider, 'pointerLeave');
    expect(screen.queryByTestId('seek-bars-hovered')).toBeNull();
  });

  it('says when its tip shows (a drag, a web hover), so the slot above can make way', async () => {
    Platform.OS = 'web';
    const onTip = jest.fn();
    await render(<SeekBar {...bar({ onTip })} />);
    await layout(400);
    expect(onTip).not.toHaveBeenCalled();
    const [pan] = lastGesture();
    await act(async () => pan.handlers.onBegin({ x: 200 }));
    expect(onTip).toHaveBeenLastCalledWith(true);
    await act(async () => pan.handlers.onFinalize({ x: 200 }, true));
    expect(onTip).toHaveBeenLastCalledWith(false);
    const slider = screen.getByRole('adjustable');
    const rect = { getBoundingClientRect: () => ({ left: 0, width: 400 }) };
    await fireEvent(slider, 'pointerMove', { nativeEvent: { clientX: 300 }, currentTarget: rect });
    expect(onTip).toHaveBeenLastCalledWith(true);
    await fireEvent(slider, 'pointerLeave');
    expect(onTip).toHaveBeenLastCalledWith(false);
  });

  it('keeps the hover tip away when hoverTip is off, still shading and still tipping a drag', async () => {
    // The full player turns it off while its Undo chip is up: the pointer is still on
    // the bar after the click that made the chip, and the tip would keep it hidden.
    Platform.OS = 'web';
    const onTip = jest.fn();
    await render(<SeekBar {...bar({ onTip, hoverTip: false })} />);
    await layout(400);
    const slider = screen.getByRole('adjustable');
    const rect = { getBoundingClientRect: () => ({ left: 0, width: 400 }) };
    await fireEvent(slider, 'pointerMove', { nativeEvent: { clientX: 300 }, currentTarget: rect });
    expect(screen.getByTestId('seek-bars-hovered')).toBeTruthy();
    expect(screen.queryByText('Click to jump')).toBeNull();
    expect(onTip).not.toHaveBeenCalled();
    const [pan] = lastGesture();
    await act(async () => pan.handlers.onBegin({ x: 200 }));
    expect(screen.getByText('38:54')).toBeTruthy();
    expect(onTip).toHaveBeenLastCalledWith(true);
  });

  it('leaves a vertical touch to the scrolling player on the web (touch-action pan-y)', async () => {
    // Gesture-handler's default is `none`: a swipe that starts on the bar could never
    // scroll the player's column.
    mockTouchActions.length = 0;
    await render(<SeekBar {...bar()} />);
    expect(mockTouchActions.at(-1)).toBe('pan-y');
  });

  it('uses real peaks when given (same bars, any length)', async () => {
    await render(<SeekBar {...bar({ peaks: [0.1, 0.9, 0.4] })} />);
    await layout();
    expect(screen.getByTestId('seek-bars-played')).toBeTruthy();
  });
});

describe('seekTextureKey', () => {
  it('is one look per book and segment', () => {
    expect(seekTextureKey('srv:1:a', 1800.4)).toBe('srv:1:a#1800');
    expect(seekTextureKey(null, 0)).toBe('#0');
  });
});

describe('SeekTimes', () => {
  beforeEach(() => jest.useFakeTimers({ now: new Date(2026, 9, 5, 21, 40) }));
  afterEach(() => jest.useRealTimers());

  it('says the time left in the chapter at the speed, and when it ends', async () => {
    await render(<SeekTimes elapsed={120} length={1380 * 1.25 + 120} rate={1.25} />);
    expect(screen.getByText('2:00')).toBeTruthy();
    const ends = formatWallClock(new Date(2026, 9, 5, 22, 3));
    expect(screen.getByText(`23m left in the chapter · ends ${ends}`)).toBeTruthy();
    expect(screen.getByText('-28:45')).toBeTruthy();
  });

  it('says file for a book without a whole-book timeline', async () => {
    await render(<SeekTimes elapsed={0} length={600} rate={1} kind="file" />);
    expect(screen.getByText(/^10m left in the file · ends /)).toBeTruthy();
  });
});

describe('PlayerSeekBar', () => {
  beforeEach(() => {
    player.setState({
      nowPlaying: { queue: { total: 36_000 } },
      bookPosition: 1800 + 2472,
      chapter: CHAPTER,
      snapshot: { trackIndex: 0, position: 4272, duration: 36_000 },
      rate: 1,
      seekBook: jest.fn(),
      seekInTrack: jest.fn(),
      skipSeconds: jest.fn(),
    });
  });

  it('is the current chapter, seeking in the whole book', async () => {
    await render(<PlayerSeekBar />);
    const slider = screen.getByRole('adjustable', { name: 'Position in chapter' });
    expect(slider).toHaveAccessibilityValue({ now: 2472, max: 4668 });
    await layout(400);
    const [, tap] = lastGesture();
    await act(async () => tap.handlers.onEnd({ x: 0 }, true));
    expect(player.getState().seekBook).toHaveBeenCalledWith(1800);
  });

  it('skips by the skip lengths through the store', async () => {
    await render(<PlayerSeekBar />);
    await fireEvent(screen.getByRole('adjustable'), 'accessibilityAction', {
      nativeEvent: { actionName: 'increment' },
    });
    expect(player.getState().skipSeconds).toHaveBeenCalledWith(30);
  });

  it("shows only this chapter's bookmarks", async () => {
    await render(<PlayerSeekBar bookmarks={[1850, 2400, 9000]} />);
    await layout(400);
    // 1850 and 2400 fall in the chapter (1800..6468), 9000 doesn't.
    expect(screen.getAllByTestId('seek-bookmark')).toHaveLength(2);
  });

  it('works per file without a whole-book timeline', async () => {
    player.setState({
      nowPlaying: { queue: { total: 0 } },
      chapter: null,
      snapshot: { trackIndex: 2, position: 30, duration: 600 },
    });
    await render(<PlayerSeekBar />);
    const slider = screen.getByRole('adjustable', { name: 'Position in file' });
    expect(slider).toHaveAccessibilityValue({ now: 30, max: 600 });
    await layout(400);
    const [, tap] = lastGesture();
    await act(async () => tap.handlers.onEnd({ x: 200 }, true));
    expect(player.getState().seekInTrack).toHaveBeenCalledWith(300);
    expect(screen.getByText(/left in the file/)).toBeTruthy();
  });

  it('follows a scrub in its times row, and hides the row under the timeline tip', async () => {
    await render(<PlayerSeekBar />);
    await layout(400);
    expect(screen.getByText('41:12')).toBeTruthy();
    const [pan] = lastGesture();
    await act(async () => pan.handlers.onBegin({ x: 100 }));
    // A quarter of 1:17:48, in the tip and in the times row.
    expect(screen.getAllByText('19:27')).toHaveLength(2);
    await act(async () => pan.handlers.onFinalize({ x: 100 }, true));
    await screen.rerender(<PlayerSeekBar timesHidden />);
    expect(screen.queryByText('41:12')).toBeNull();
    expect(screen.getByText('41:12', { includeHiddenElements: true })).toBeTruthy();
  });

  it('names a chapterless book as the book, not a chapter', async () => {
    jest.useFakeTimers({ now: new Date(2026, 9, 5, 21, 40) });
    // A 40-minute single file: a whole-book timeline, no chapters.
    player.setState({ nowPlaying: { queue: { total: 2400 } }, bookPosition: 600, chapter: null });
    await render(<PlayerSeekBar />);
    expect(screen.getByRole('adjustable', { name: 'Position in book' })).toBeTruthy();
    expect(screen.getByText(/^30m left in the book · ends /)).toBeTruthy();
    jest.useRealTimers();
  });

  it('keeps the chapter it was dragging in when playback crosses into the next', async () => {
    await render(<PlayerSeekBar />);
    await layout(400);
    const [pan] = lastGesture();
    await act(async () => pan.handlers.onBegin({ x: 100 }));
    // The book plays on into the next chapter while the finger is down.
    const next: Chapter = { index: 23, title: 'Next', start: 0, end: 1000, book_offset: 6468 };
    await act(async () => player.setState({ chapter: next, bookPosition: 6470 }));
    const [panNow] = lastGesture();
    await act(async () => panNow.handlers.onEnd({ x: 200 }, true));
    // Half of the chapter being scrubbed (1800 + 4668 / 2), not of the next one.
    expect(player.getState().seekBook).toHaveBeenLastCalledWith(1800 + 2334);
    await act(async () => panNow.handlers.onFinalize({ x: 200 }, true));
    // Released, it follows the playing chapter again.
    expect(screen.getByRole('adjustable')).toHaveAccessibilityValue({ max: 1000 });
  });

  it('renders nothing with no book', async () => {
    player.setState({ nowPlaying: null });
    await render(<PlayerSeekBar />);
    expect(screen.toJSON()).toBeNull();
  });
});
