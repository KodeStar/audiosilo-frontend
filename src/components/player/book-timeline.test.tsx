import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Platform, StyleSheet } from 'react-native';
import type { StoreApi, UseBoundStore } from 'zustand';

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

type MockPlayer = {
  nowPlaying: {
    queue: {
      total: number;
      offsets: number[];
      chapters: { index: number; title: string; book_offset: number }[];
    };
  } | null;
  bookPosition: number;
  snapshot: { trackIndex: number; position: number };
  seekBook: jest.Mock;
  seekInTrack: jest.Mock;
  goToTrack: jest.Mock;
};
jest.mock('@/playback/store', () => {
  const { create } = jest.requireActual('zustand');
  return {
    usePlayer: create(() => ({})),
    selectBookPosition: (s: MockPlayer) => s.bookPosition,
  };
});

/* eslint-disable import/first */
import { usePlayer } from '@/playback/store';

import { BookTimeline, PlayerBookTimeline } from './book-timeline';
/* eslint-enable import/first */

const player = usePlayer as unknown as UseBoundStore<StoreApi<MockPlayer>>;

type Handlers = { onEnd: (e: { x: number }, success: boolean) => void };
type Gestures = { toGestureArray: () => { handlers: Handlers }[] };
const tapAt = async (x: number) => {
  const [, tap] = (mockGestures.at(-1) as Gestures).toGestureArray();
  await act(async () => tap.handlers.onEnd({ x }, true));
};

const STARTS = [0, 600, 1800, 3000];
/** The required handlers, for a timeline whose seeking the test does not look at. */
const H = { onSeek: jest.fn(), onStep: jest.fn() };
const TITLES = ['Prelude', 'Stormblessed', 'Bridge Four', 'The Shattered Plains'];

beforeEach(() => {
  mockGestures.length = 0;
  mockTouchActions.length = 0;
});

async function layout(width = 400) {
  await fireEvent(screen.getByLabelText('Whole-book timeline'), 'layout', {
    nativeEvent: { layout: { width, height: 40 } },
  });
}

describe('BookTimeline', () => {
  const prevOS = Platform.OS;
  afterEach(() => {
    Platform.OS = prevOS;
  });

  it('draws a segment per chapter: past, current, ahead', async () => {
    await render(
      <BookTimeline starts={STARTS} total={4000} position={2000} titles={TITLES} {...H} />,
    );
    expect(screen.getAllByTestId('timeline-segment-past')).toHaveLength(2);
    expect(screen.getAllByTestId('timeline-segment-current')).toHaveLength(1);
    expect(screen.getAllByTestId('timeline-segment-ahead')).toHaveLength(1);
  });

  it('places each segment by its time, where the playhead, taps and pins map it', async () => {
    // Uneven chapters: 0-10%, 10-60%, 60-70% and 70-100% of the book.
    await render(
      <BookTimeline starts={[0, 400, 2400, 2800]} total={4000} position={2500} {...H} />,
    );
    await layout(400);
    const segments = screen.getAllByTestId(/^timeline-segment-/);
    expect(segments.map((s) => StyleSheet.flatten(s.props.style))).toEqual([
      expect.objectContaining({ left: '0%', width: '10%' }),
      expect.objectContaining({ left: '10%', width: '50%' }),
      expect.objectContaining({ left: '60%', width: '10%' }),
      expect.objectContaining({ left: '70%', width: '30%' }),
    ]);
    // The 2-point gap comes out of each run's own end (none after the last), so it never
    // pushes a later segment along.
    const gaps = segments.map(
      (s) => StyleSheet.flatten((s.children[0] as typeof s).props.style).marginRight,
    );
    expect(gaps).toEqual([2, 2, 2, 0]);
  });

  it('lets a touch that starts on it scroll the page on the web', async () => {
    await render(<BookTimeline starts={STARTS} total={4000} position={0} {...H} />);
    // Gesture-handler's default is `none`, which keeps the page from scrolling.
    expect(mockTouchActions.at(-1)).toBe('pan-y');
  });

  it('is an adjustable "Whole-book timeline" naming the chapter and the place', async () => {
    await render(
      <BookTimeline starts={STARTS} total={4000} position={2000} titles={TITLES} {...H} />,
    );
    expect(
      screen.getByRole('adjustable', { name: 'Whole-book timeline' }),
    ).toHaveAccessibilityValue({
      min: 0,
      max: 4000,
      now: 2000,
      text: 'Bridge Four, 50%, 33:20 of 1:06:40',
    });
  });

  it('seeks where it is tapped', async () => {
    const onSeek = jest.fn();
    await render(
      <BookTimeline starts={STARTS} total={4000} position={0} onSeek={onSeek} onStep={jest.fn()} />,
    );
    await layout(400);
    await tapAt(100);
    expect(onSeek).toHaveBeenCalledWith(1000);
  });

  it('lands a tap on a pin exactly on its place', async () => {
    const onSeek = jest.fn();
    await render(
      <BookTimeline
        starts={STARTS}
        total={4000}
        position={0}
        bookmarks={[1030]}
        onSeek={onSeek}
        onStep={jest.fn()}
      />,
    );
    await layout(400);
    // 1030 is at 103 points; a tap 5 points off is on the pin's head (16 wide).
    await tapAt(108);
    expect(onSeek).toHaveBeenLastCalledWith(1030);
    // Well clear of it, the tap seeks where it is.
    await tapAt(200);
    expect(onSeek).toHaveBeenLastCalledWith(2000);
  });

  it('hands the screen-reader steps to onStep', async () => {
    const onStep = jest.fn();
    await render(
      <BookTimeline
        starts={STARTS}
        total={4000}
        position={2000}
        onSeek={jest.fn()}
        onStep={onStep}
      />,
    );
    const slider = screen.getByRole('adjustable');
    await fireEvent(slider, 'accessibilityAction', { nativeEvent: { actionName: 'increment' } });
    await fireEvent(slider, 'accessibilityAction', { nativeEvent: { actionName: 'decrement' } });
    expect(onStep.mock.calls).toEqual([[1], [-1]]);
  });

  it('shows bookmark and note pins above the track, dropping any outside the book', async () => {
    const props = { starts: STARTS, total: 4000, position: 0, ...H };
    await render(<BookTimeline {...props} bookmarks={[100, 200]} notes={[300, 9000]} />);
    expect(screen.getAllByTestId('timeline-bookmark')).toHaveLength(2);
    expect(screen.getAllByTestId('timeline-note')).toHaveLength(1);
    await screen.rerender(<BookTimeline {...props} />);
    expect(screen.queryByTestId('timeline-bookmark')).toBeNull();
  });

  it('says when its tip shows, so the times row above can make way', async () => {
    Platform.OS = 'web';
    const onTip = jest.fn();
    await render(<BookTimeline starts={STARTS} total={4000} position={0} onTip={onTip} {...H} />);
    await layout(400);
    const rect = { getBoundingClientRect: () => ({ left: 0, width: 400 }) };
    const slider = screen.getByRole('adjustable');
    await fireEvent(slider, 'pointerMove', { nativeEvent: { clientX: 200 }, currentTarget: rect });
    expect(onTip).toHaveBeenLastCalledWith(true);
    await fireEvent(slider, 'pointerLeave');
    expect(onTip).toHaveBeenLastCalledWith(false);
  });

  it('names the chapter under the pointer on the web', async () => {
    Platform.OS = 'web';
    await render(<BookTimeline starts={STARTS} total={4000} position={0} titles={TITLES} {...H} />);
    await layout(400);
    const rect = { getBoundingClientRect: () => ({ left: 0, width: 400 }) };
    await fireEvent(screen.getByRole('adjustable'), 'pointerMove', {
      nativeEvent: { clientX: 200 },
      currentTarget: rect,
    });
    expect(screen.getByText('Bridge Four · 33:20')).toBeTruthy();
  });

  it('renders a chapterless book as one segment, and nothing without a length', async () => {
    await render(<BookTimeline starts={[]} total={4000} position={1000} {...H} />);
    expect(screen.getAllByTestId('timeline-segment-current')).toHaveLength(1);
    await screen.rerender(<BookTimeline starts={[]} total={0} position={1000} {...H} />);
    expect(screen.toJSON()).toBeNull();
  });
});

describe('PlayerBookTimeline', () => {
  const prevOS = Platform.OS;
  afterEach(() => {
    Platform.OS = prevOS;
  });

  beforeEach(() => {
    player.setState({
      nowPlaying: {
        queue: {
          total: 4000,
          offsets: [0],
          chapters: STARTS.map((s, i) => ({ index: i, title: TITLES[i], book_offset: s })),
        },
      },
      bookPosition: 2000,
      snapshot: { trackIndex: 0, position: 2000 },
      seekBook: jest.fn(),
      seekInTrack: jest.fn(),
      goToTrack: jest.fn(),
    });
  });

  it("is the playing book's chapters, place and pins, seeking through the store", async () => {
    await render(<PlayerBookTimeline pins={{ bookmarks: [500], notes: [1500, 99_999] }} />);
    expect(screen.getAllByTestId('timeline-bookmark')).toHaveLength(1);
    // The note past the end is dropped.
    expect(screen.getAllByTestId('timeline-note')).toHaveLength(1);
    await layout(400);
    await tapAt(300);
    expect(player.getState().seekBook).toHaveBeenCalledWith(3000);
  });

  it('never lands a scrub on the very end of the book, which would finish it', async () => {
    Platform.OS = 'web';
    await render(<PlayerBookTimeline />);
    await layout(400);
    // A drag or tap released past the right edge: 30 s short of the end, so the book is
    // not finished and the Undo chip can still take the listener back.
    await tapAt(420);
    expect(player.getState().seekBook).toHaveBeenLastCalledWith(3970);
    // The End key too.
    await fireEvent(screen.getByRole('adjustable'), 'keyDown', {
      key: 'End',
      preventDefault: jest.fn(),
    });
    expect(player.getState().seekBook).toHaveBeenCalledTimes(2);
    expect(player.getState().seekBook).toHaveBeenLastCalledWith(3970);
  });

  it('steps to the next chapter like the transport', async () => {
    await render(<PlayerBookTimeline />);
    await fireEvent(screen.getByRole('adjustable'), 'accessibilityAction', {
      nativeEvent: { actionName: 'increment' },
    });
    expect(player.getState().seekBook).toHaveBeenCalledWith(3000);
  });

  it('renders nothing for a per-file book or no book', async () => {
    player.setState({
      nowPlaying: { queue: { total: 0, offsets: [0, 0], chapters: [] } },
    });
    await render(<PlayerBookTimeline />);
    expect(screen.toJSON()).toBeNull();
    await act(async () => player.setState({ nowPlaying: null }));
    expect(screen.toJSON()).toBeNull();
  });
});
