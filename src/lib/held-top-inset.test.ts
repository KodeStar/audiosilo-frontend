import { renderHook } from '@testing-library/react-native';

import { useHeldTopInset } from './held-top-inset';

describe('useHeldTopInset', () => {
  it('keeps the largest top inset for a window size, and measures afresh at a new one', async () => {
    const portrait = { width: 400, height: 800 };
    const { result, rerender } = await renderHook(
      ({ top, window }: { top: number; window: { width: number; height: number } }) =>
        useHeldTopInset(top, window),
      { initialProps: { top: 24, window: portrait } },
    );
    expect(result.current).toBe(24);
    // The status bar hidden: the inset drops, the room holds.
    await rerender({ top: 0, window: portrait });
    expect(result.current).toBe(24);
    await rerender({ top: 30, window: portrait });
    expect(result.current).toBe(30);
    // A rotation: the new window's own inset, held from there.
    const landscape = { width: 800, height: 400 };
    await rerender({ top: 0, window: landscape });
    expect(result.current).toBe(0);
    await rerender({ top: 12, window: landscape });
    expect(result.current).toBe(12);
  });
});
