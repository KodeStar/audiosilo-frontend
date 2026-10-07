import { act, renderHook } from '@testing-library/react-native';

import { CARD_MS } from './story-model';
import { useStoryPlayer } from './use-story-player';

type Props = { count: number; held: boolean; still: boolean; initial?: number };

async function mount(props: Partial<Props> = {}) {
  return renderHook(
    (p: Props) => useStoryPlayer(p.count, { held: p.held, still: p.still, initial: p.initial }),
    { initialProps: { count: 4, held: false, still: false, ...props } },
  );
}

const tick = (ms: number) => act(async () => void jest.advanceTimersByTime(ms));

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('useStoryPlayer', () => {
  it('moves to the next card every six seconds and stops on the last', async () => {
    const { result } = await mount({ count: 3 });
    expect(result.current.index).toBe(0);
    await tick(CARD_MS - 1);
    expect(result.current.index).toBe(0);
    await tick(1);
    expect(result.current.index).toBe(1);
    await tick(CARD_MS);
    expect(result.current.index).toBe(2);
    await tick(CARD_MS * 3);
    expect(result.current.index).toBe(2);
  });

  it('starts on the card it was opened at', async () => {
    const { result } = await mount({ initial: 2 });
    expect(result.current.index).toBe(2);
  });

  it('freezes while held and resumes with the time the card had left', async () => {
    const { result, rerender } = await mount();
    await tick(4000);
    await act(async () => rerender({ count: 4, held: true, still: false }));
    await tick(CARD_MS * 2);
    expect(result.current.index).toBe(0);
    await act(async () => rerender({ count: 4, held: false, still: false }));
    await tick(1999);
    expect(result.current.index).toBe(0);
    await tick(1);
    expect(result.current.index).toBe(1);
  });

  it('never moves by itself with reduced motion, and shows the bar full', async () => {
    const { result } = await mount({ still: true });
    await tick(CARD_MS * 3);
    expect(result.current.index).toBe(0);
    expect(result.current.progress.value).toBe(1);
  });

  it('moves on taps: next wraps, previous stops at the first, each restarts the time', async () => {
    const { result } = await mount({ count: 3 });
    await tick(5000);
    await act(async () => result.current.next());
    expect(result.current.index).toBe(1);
    await tick(5000);
    expect(result.current.index).toBe(1); // a fresh six seconds
    await act(async () => result.current.goTo(2));
    await act(async () => result.current.next());
    expect(result.current.index).toBe(0);
    await act(async () => result.current.previous());
    expect(result.current.index).toBe(0);
    await tick(CARD_MS);
    expect(result.current.index).toBe(1);
  });

  it('keeps its card inside a story that got shorter', async () => {
    const { result, rerender } = await mount({ initial: 3 });
    await act(async () => rerender({ count: 2, held: false, still: false }));
    expect(result.current.index).toBe(1);
  });
});
