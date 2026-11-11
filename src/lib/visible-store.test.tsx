import { act, renderHook } from '@testing-library/react-native';
import { createStore } from 'zustand';

import { driveAppState } from '@/testing/app-state';

import { quietOffScreen } from './visible-store';

const app = driveAppState();

type Clock = { seconds: number; running: boolean; label: string };
const clock = () => createStore<Clock>()(() => ({ seconds: 0, running: true, label: 'a' }));
/** The app's state changes, inside React's `act` so a mounted reader renders what it is shown. */
const appGoes = (state: 'active' | 'inactive' | 'background') =>
  act(async () => app.becomes(state));

/** A store that ticks, its hook, and how often a reader of the hook rendered. */
async function mounted<U>(selector: (s: Clock) => U) {
  const store = clock();
  // A tick: the seconds moved on. A jump back is not one.
  const useClock = quietOffScreen(store, 'seconds', (shown, live) => live >= shown);
  let renders = 0;
  const hook = await renderHook(() => {
    renders++;
    return useClock(selector);
  });
  const set = (patch: Partial<Clock>) => act(async () => store.setState(patch));
  return { store, useClock, hook, set, renders: () => renders };
}

afterEach(() => appGoes('active'));

describe('quietOffScreen', () => {
  it('shows every change while the app is in front', async () => {
    const { hook, set, renders } = await mounted((s) => s.seconds);
    await set({ seconds: 1 });
    await set({ seconds: 2 });
    expect(hook.result.current).toBe(2);
    expect(renders()).toBe(3);
  });

  it('shows no tick off screen: nothing renders, and the store itself stays live', async () => {
    const { store, useClock, hook, set, renders } = await mounted((s) => s.seconds);
    const heard = jest.fn();
    useClock.subscribe(heard);
    await set({ seconds: 1 });
    await appGoes('background');
    for (let seconds = 2; seconds <= 60; seconds++) await set({ seconds });
    expect(hook.result.current).toBe(1);
    expect(renders()).toBe(2);
    // The hook's own `getState` and `subscribe` are the store's: never held.
    expect(useClock.getState().seconds).toBe(60);
    expect(useClock.getState()).toBe(store.getState());
    expect(heard).toHaveBeenCalledTimes(60);
  });

  it('runs no selector for a tick off screen', async () => {
    const selector = jest.fn((s: Clock) => s.running);
    const { set } = await mounted(selector);
    await appGoes('background');
    selector.mockClear();
    for (let seconds = 1; seconds <= 10; seconds++) await set({ seconds });
    expect(selector).not.toHaveBeenCalled();
  });

  it('shows the live state at once on coming back', async () => {
    const { hook, set, renders } = await mounted((s) => s.seconds);
    await appGoes('background');
    await set({ seconds: 30 });
    expect(hook.result.current).toBe(0);
    await appGoes('active');
    expect(hook.result.current).toBe(30);
    expect(renders()).toBe(2);
    await set({ seconds: 31 });
    expect(hook.result.current).toBe(31);
  });

  it('shows any other change off screen at once, the held field with it', async () => {
    const { hook, set } = await mounted((s) => `${s.seconds}:${s.running}`);
    await appGoes('background');
    await set({ seconds: 5 });
    expect(hook.result.current).toBe('0:true');
    await set({ running: false });
    expect(hook.result.current).toBe('5:false');
    // A change of another field in the same write as a tick is not a tick.
    await set({ seconds: 6, label: 'b' });
    expect(hook.result.current).toBe('6:false');
  });

  it('shows a change of the held field that is not a tick', async () => {
    const { hook, set } = await mounted((s) => s.seconds);
    await set({ seconds: 40 });
    await appGoes('background');
    await set({ seconds: 41 });
    expect(hook.result.current).toBe(40);
    await set({ seconds: 3 }); // back: not further on
    expect(hook.result.current).toBe(3);
  });

  it('keeps showing ticks while iOS has the app inactive (still seen behind what covers it)', async () => {
    const { hook, set } = await mounted((s) => s.seconds);
    await appGoes('inactive');
    await set({ seconds: 1 });
    expect(hook.result.current).toBe(1);
  });

  it('gives the whole shown state to a reader with no selector', async () => {
    const store = clock();
    const useClock = quietOffScreen(store, 'seconds', () => true);
    const hook = await renderHook(() => useClock());
    await appGoes('background');
    await act(async () => store.setState({ seconds: 9 }));
    expect(hook.result.current.seconds).toBe(0);
    await appGoes('active');
    expect(hook.result.current).toBe(store.getState());
  });

  it('shows a reader mounted off screen the state last shown, then the live one', async () => {
    const store = clock();
    const useClock = quietOffScreen(store, 'seconds', () => true);
    await appGoes('background');
    store.setState({ seconds: 7 });
    const hook = await renderHook(() => useClock((s) => s.seconds));
    expect(hook.result.current).toBe(0);
    await appGoes('active');
    expect(hook.result.current).toBe(7);
  });
});
