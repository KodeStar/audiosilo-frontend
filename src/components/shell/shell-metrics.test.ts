import { act, renderHook } from '@testing-library/react-native';

import { bottomChromeTop, setChromeEdge, useChromeEdge, useShellMetrics } from './shell-metrics';

beforeEach(() => useShellMetrics.setState({ edges: {} }));

describe('bottomChromeTop', () => {
  it('is the highest piece, or nothing before any layout', () => {
    expect(bottomChromeTop({})).toBeUndefined();
    expect(bottomChromeTop({ bar: 83, mini: 149 })).toBe(149);
    expect(bottomChromeTop({ dock: 84 })).toBe(84);
  });
});

describe('chrome edges', () => {
  it('publishes and withdraws a piece', () => {
    setChromeEdge('bar', 64);
    setChromeEdge('mini', 130);
    expect(useShellMetrics.getState().edges).toEqual({ bar: 64, mini: 130 });
    setChromeEdge('mini', undefined);
    expect(useShellMetrics.getState().edges).toEqual({ bar: 64 });
  });

  it('follows a component: its edge while shown, nothing once it hides or unmounts', async () => {
    const { rerender, unmount } = await renderHook(
      ({ edge }: { edge: number | undefined }) => useChromeEdge('dock', edge),
      { initialProps: { edge: 84 as number | undefined } },
    );
    expect(useShellMetrics.getState().edges.dock).toBe(84);
    await rerender({ edge: undefined });
    expect(useShellMetrics.getState().edges.dock).toBeUndefined();
    await rerender({ edge: 105 });
    expect(useShellMetrics.getState().edges.dock).toBe(105);
    await act(async () => unmount());
    expect(useShellMetrics.getState().edges).toEqual({});
  });
});
