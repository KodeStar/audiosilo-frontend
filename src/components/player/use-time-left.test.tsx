import { act, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import type { StoreApi, UseBoundStore } from 'zustand';

type MockPlayer = {
  position: number;
  rate: number;
  nowPlaying: {
    connectionId: string;
    libraryId: number;
    path: string;
    queue: { total: number };
  } | null;
};
jest.mock('@/playback/store', () => {
  const { create: createStore } = jest.requireActual('zustand');
  const usePlayer = createStore(() => ({ position: 0, rate: 1, nowPlaying: null }));
  return { usePlayer, selectBookPosition: (s: MockPlayer) => s.position };
});

/* eslint-disable import/first */
import { usePlayer as realUsePlayer } from '@/playback/store';
import { useSettings } from '@/stores/settings';

import { type BookRef, useBookSpeed, useBookTimeLeft, usePlayingTimeLeft } from './use-time-left';
/* eslint-enable import/first */

const player = realUsePlayer as unknown as UseBoundStore<StoreApi<MockPlayer>>;

const BOOK: BookRef = { connectionId: 'srv', libraryId: 1, path: 'a/book' };
const OTHER: BookRef = { ...BOOK, path: 'a/other' };
const loaded = (total: number) => ({ ...BOOK, queue: { total } });

const onRender = jest.fn();
const renders = () => onRender.mock.calls.length;
function Playing() {
  onRender();
  return <Text testID="left">{usePlayingTimeLeft()}</Text>;
}
function AnyBook(props: { book: BookRef; position: number; duration: number; speed?: number }) {
  const left = useBookTimeLeft(props.book, {
    position: props.position,
    duration: props.duration,
    playback_speed: props.speed,
  });
  const speed = useBookSpeed(props.book, props.speed);
  return (
    <>
      <Text testID="left">{left}</Text>
      <Text testID="speed">{String(speed)}</Text>
    </>
  );
}

beforeEach(() => {
  onRender.mockClear();
  player.setState({ position: 0, rate: 1, nowPlaying: null });
  useSettings.setState({ defaultRate: 1 });
});

describe('usePlayingTimeLeft', () => {
  it("is the playing book's time left at the player's speed", async () => {
    player.setState({ position: 600, rate: 2, nowPlaying: loaded(7800) });
    await render(<Playing />);
    // (7800 - 600) / 2 = 3600 s.
    expect(screen.getByTestId('left')).toHaveTextContent('1h left at 2×');
  });

  it('is empty with nothing loaded or an unknown length', async () => {
    await render(<Playing />);
    expect(screen.getByTestId('left')).toHaveTextContent('');
    await act(async () => player.setState({ nowPlaying: loaded(0), position: 50 }));
    expect(screen.getByTestId('left')).toHaveTextContent('');
  });

  it('re-renders only when the text changes, not on every engine tick', async () => {
    player.setState({ position: 100, nowPlaying: loaded(7300) });
    await render(<Playing />);
    const before = renders();
    for (const position of [100.1, 100.2, 100.3, 100.4]) {
      await act(async () => player.setState({ position }));
    }
    expect(renders()).toBe(before);
    await act(async () => player.setState({ position: 160 }));
    expect(renders()).toBe(before + 1);
    expect(screen.getByTestId('left')).toHaveTextContent('1h 59m left');
  });
});

describe('useBookTimeLeft / useBookSpeed', () => {
  it("uses a book's own saved speed when it is not loaded (frontend#50)", async () => {
    await render(<AnyBook book={OTHER} position={0} duration={3600} speed={1.5} />);
    expect(screen.getByTestId('left')).toHaveTextContent('40m left at 1.5×');
    expect(screen.getByTestId('speed')).toHaveTextContent('1.5');
  });

  it('falls back to the default speed setting without a saved speed', async () => {
    useSettings.setState({ defaultRate: 1.25 });
    await render(<AnyBook book={OTHER} position={0} duration={3600} />);
    expect(screen.getByTestId('left')).toHaveTextContent('48m left at 1.25×');
  });

  it("follows the player's place and speed while the book is loaded", async () => {
    player.setState({ position: 1800, rate: 2, nowPlaying: loaded(3600) });
    await render(<AnyBook book={BOOK} position={0} duration={3600} speed={1} />);
    expect(screen.getByTestId('left')).toHaveTextContent('15m left at 2×');
    expect(screen.getByTestId('speed')).toHaveTextContent('2');
  });

  it('keeps the saved place while the loaded book still reads 0', async () => {
    player.setState({ position: 0, rate: 1, nowPlaying: loaded(3600) });
    await render(<AnyBook book={BOOK} position={1800} duration={3600} speed={1} />);
    expect(screen.getByTestId('left')).toHaveTextContent('30m left');
  });
});
