import { act, renderHook } from '@testing-library/react-native';

import {
  bottomChromeTop,
  nativeBarEdge,
  setChromeEdge,
  setFrameBottom,
  useChromeEdge,
  useShellMetrics,
} from './shell-metrics';

beforeEach(() => useShellMetrics.setState({ edges: {} }));

describe('bottomChromeTop', () => {
  it('is the highest piece, or nothing before any layout', () => {
    expect(bottomChromeTop({})).toBeUndefined();
    expect(bottomChromeTop({ bar: 83, mini: 149 })).toBe(149);
    expect(bottomChromeTop({ dock: 84 })).toBe(84);
  });

  it('can leave one piece out (the grace card sits on the rest)', () => {
    expect(bottomChromeTop({ dock: 84, grace: 190 })).toBe(190);
    expect(bottomChromeTop({ dock: 84, grace: 190 }, 'grace')).toBe(84);
    expect(bottomChromeTop({ grace: 190 }, 'grace')).toBeUndefined();
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

it('records the frame bottom beside the edges, which bottomChromeTop ignores', () => {
  setChromeEdge('bar', 104);
  setFrameBottom(900);
  expect(useShellMetrics.getState().frameBottom).toBe(900);
  expect(bottomChromeTop(useShellMetrics.getState().edges)).toBe(104);
});

describe('nativeBarEdge', () => {
  it('waits for both the page and the frame to be measured', () => {
    expect(nativeBarEdge(24, undefined, 796)).toBeUndefined();
    expect(nativeBarEdge(24, 900, undefined)).toBeUndefined();
  });

  it('is the gap between the frame and page bottoms, in the same measured space', () => {
    // Android, edge-to-edge: measureInWindow is offset by the 52pt status bar (the page
    // reads y -52, height 848 in a 952pt window), so the frame reads 900, not 952. The bar
    // is 104, not the 156 a comparison with the window height gave.
    expect(nativeBarEdge(24, -52 + 952, -52 + 848)).toBe(104);
  });

  it('is at least the bottom inset (iOS lays the page out under its bar)', () => {
    expect(nativeBarEdge(83, 844, 844)).toBe(83);
  });
});
