import { act, render, screen } from '@testing-library/react-native';
import type { StoreApi, UseBoundStore } from 'zustand';

type MockPlayer = { position: number; rate: number };
jest.mock('@/playback/store', () => {
  const { create: createStore } = jest.requireActual('zustand');
  const usePlayer = createStore(() => ({ position: 0, rate: 1 }));
  return { usePlayer, selectBookPosition: (s: MockPlayer) => s.position };
});

/* eslint-disable import/first */
import { usePlayer as realUsePlayer } from '@/playback/store';

import { BookProgressLine } from './book-progress';
/* eslint-enable import/first */

const player = realUsePlayer as unknown as UseBoundStore<StoreApi<MockPlayer>>;

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
