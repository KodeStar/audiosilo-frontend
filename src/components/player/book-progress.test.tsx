import { act, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import type { StoreApi, UseBoundStore } from 'zustand';

type MockPlayer = { position: number; rate: number };
jest.mock('@/playback/store', () => {
  const { create: createStore } = jest.requireActual('zustand');
  const usePlayer = createStore(() => ({ position: 0, rate: 1 }));
  return { usePlayer, selectBookPosition: (s: MockPlayer) => s.position };
});

/* eslint-disable import/first */
import { usePlayer as realUsePlayer } from '@/playback/store';

import { BookProgressLine, useBookTimeLeft } from './book-progress';
/* eslint-enable import/first */

const player = realUsePlayer as unknown as UseBoundStore<StoreApi<MockPlayer>>;

const onRender = jest.fn();
const renders = () => onRender.mock.calls.length;
function TimeLeftProbe({ total }: { total: number }) {
  onRender();
  return <Text testID="left">{useBookTimeLeft(total)}</Text>;
}

beforeEach(() => {
  onRender.mockClear();
  player.setState({ position: 0, rate: 1 });
});

describe('useBookTimeLeft', () => {
  it('formats the wall-clock time left at the listener speed', async () => {
    player.setState({ position: 600, rate: 2 });
    await render(<TimeLeftProbe total={7800} />);
    // (7800 - 600) / 2 = 3600 s.
    expect(screen.getByTestId('left')).toHaveTextContent('1h');
  });

  it('is empty when nothing is left or the timeline is unknown', async () => {
    player.setState({ position: 50 });
    await render(<TimeLeftProbe total={0} />);
    expect(screen.getByTestId('left')).toHaveTextContent('');
  });

  it('re-renders only when the text changes, not on every engine tick', async () => {
    player.setState({ position: 100 });
    await render(<TimeLeftProbe total={7300} />);
    const before = renders();
    // Sub-second ticks that still read "2h": no re-render.
    for (const position of [100.1, 100.2, 100.3, 100.4]) {
      await act(async () => player.setState({ position }));
    }
    expect(renders()).toBe(before);
    // A minute later the text moves to "1h 59m".
    await act(async () => player.setState({ position: 160 }));
    expect(renders()).toBe(before + 1);
    expect(screen.getByTestId('left')).toHaveTextContent('1h 59m');
  });
});

describe('BookProgressLine', () => {
  it('fills the fraction of the book, clamped', async () => {
    player.setState({ position: 250 });
    await render(<BookProgressLine total={1000} className="h-0.5" />);
    const fillStyle = () =>
      (screen.toJSON() as unknown as { children: { props: { style: unknown } }[] }).children[0]
        .props.style;
    expect(fillStyle()).toEqual({ width: '25%' });
    await act(async () => player.setState({ position: 5000 }));
    expect(fillStyle()).toEqual({ width: '100%' });
  });
});
