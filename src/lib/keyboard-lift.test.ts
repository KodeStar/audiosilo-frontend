import { act, renderHook } from '@testing-library/react-native';
import { Dimensions, Keyboard, type KeyboardEvent, Platform } from 'react-native';

import {
  KEYBOARD_TOP_GAP,
  keyboardCap,
  keyboardLift,
  keyboardOverlap,
  useKeyboardAvoidance,
  useKeyboardFrame,
} from './keyboard-lift';

describe('keyboard maths', () => {
  it('measures the overlap from the keyboard frame’s top edge', () => {
    // iPhone Air: 912 pt tall, a 336 pt keyboard.
    expect(keyboardOverlap(912, 576)).toBe(336);
    // A hardware keyboard's bar, and a keyboard gone below the window.
    expect(keyboardOverlap(912, 868)).toBe(44);
    expect(keyboardOverlap(912, 912)).toBe(0);
    expect(keyboardOverlap(912, 1200)).toBe(0);
  });

  it('gives a window resized for the keyboard no overlap, one edge to edge all of it', () => {
    // Pixel 6a edge to edge: 915 dp tall, the keyboard's top at 590 dp.
    expect(keyboardOverlap(915, 590)).toBe(325);
    // The same keyboard over a window resized to end at it (adjustResize, not edge to edge).
    expect(keyboardOverlap(590, 590)).toBe(0);
  });

  it('lifts a panel that pads for the home indicator by the rest of the keyboard', () => {
    expect(keyboardLift(336, 34)).toBe(302);
    expect(keyboardLift(0, 34)).toBe(0);
    expect(keyboardLift(20, 34)).toBe(0);
  });

  it('caps the panel to what the keyboard leaves under the top safe edge', () => {
    const base = { windowHeight: 912, fraction: 0.85, topInset: 62 };
    expect(keyboardCap({ ...base, overlap: 0 })).toBe(Math.round(912 * 0.85));
    expect(keyboardCap({ ...base, overlap: 336 })).toBe(912 - 336 - 62 - KEYBOARD_TOP_GAP);
    // A short panel's usual cap already fits.
    expect(keyboardCap({ ...base, fraction: 0.3, overlap: 336 })).toBe(Math.round(912 * 0.3));
  });
});

describe('useKeyboardFrame', () => {
  const OS = Platform.OS;
  afterEach(() => {
    Platform.OS = OS;
    jest.restoreAllMocks();
  });

  const listen = () => {
    const handlers: Record<string, (e: KeyboardEvent) => void> = {};
    jest.spyOn(Keyboard, 'addListener').mockImplementation(((
      name: string,
      cb: (e: KeyboardEvent) => void,
    ) => {
      handlers[name] = cb;
      return { remove: jest.fn() };
    }) as never);
    return handlers;
  };
  const event = (screenY: number, duration = 250) =>
    ({ duration, endCoordinates: { screenY, height: 0, screenX: 0, width: 0 } }) as KeyboardEvent;

  it('follows the iOS keyboard in and out', async () => {
    Platform.OS = 'ios';
    const handlers = listen();
    const { result } = await renderHook(() => useKeyboardFrame());
    expect(result.current.overlap).toBe(0);
    const { height } = Dimensions.get('window');
    await act(() => handlers.keyboardWillShow(event(height - 300)));
    expect(result.current).toEqual({ overlap: 300, duration: 250 });
    await act(() => handlers.keyboardWillHide(event(height)));
    expect(result.current.overlap).toBe(0);
  });

  it('listens to nothing while its overlay is closed, and forgets the keyboard on closing', async () => {
    Platform.OS = 'ios';
    const handlers = listen();
    const { height } = Dimensions.get('window');
    const view = await renderHook(({ active }: { active: boolean }) => useKeyboardFrame(active), {
      initialProps: { active: false },
    });
    expect(handlers.keyboardWillShow).toBeUndefined();
    await view.rerender({ active: true });
    await act(() => handlers.keyboardWillShow(event(height - 300)));
    expect(view.result.current.overlap).toBe(300);
    await view.rerender({ active: false });
    expect(view.result.current.overlap).toBe(0);
  });

  it('starts from a keyboard already up when its overlay opens', async () => {
    Platform.OS = 'ios';
    listen();
    const { height } = Dimensions.get('window');
    jest.spyOn(Keyboard, 'metrics').mockReturnValue({
      screenX: 0,
      screenY: height - 250,
      width: 0,
      height: 250,
    });
    const { result } = await renderHook(() => useKeyboardFrame());
    expect(result.current.overlap).toBe(250);
  });

  // Will-show and will-change-frame both fire for one rise: the second must not render.
  it('keeps its answer when an event leaves the overlap as it was', async () => {
    Platform.OS = 'ios';
    const handlers = listen();
    const { height } = Dimensions.get('window');
    const { result } = await renderHook(() => useKeyboardFrame());
    await act(() => handlers.keyboardWillShow(event(height - 300)));
    const first = result.current;
    await act(() => handlers.keyboardWillChangeFrame(event(height - 300)));
    expect(result.current).toBe(first);
  });

  it('lifts and caps a panel above the keyboard (useKeyboardAvoidance)', async () => {
    Platform.OS = 'ios';
    const handlers = listen();
    const { height } = Dimensions.get('window');
    const opts = { active: true, fraction: 0.85, bottomInset: 34, topInset: 47 };
    const { result } = await renderHook(() => useKeyboardAvoidance(opts));
    expect(result.current).toEqual({ lift: 0, cap: Math.round(height * 0.85), duration: 0 });
    await act(() => handlers.keyboardWillShow(event(height - 300)));
    expect(result.current).toEqual({
      lift: 266,
      cap: keyboardCap({ windowHeight: height, fraction: 0.85, overlap: 300, topInset: 47 }),
      duration: 250,
    });
  });

  // Edge to edge (SDK 56, Android 15+) the window keeps its height for the keyboard, so
  // Android lifts like iOS (the Pixel's editor sheet sat behind the keyboard without it).
  it('follows the Android keyboard in and out, on what did happen', async () => {
    Platform.OS = 'android';
    const handlers = listen();
    const { result } = await renderHook(() => useKeyboardFrame());
    expect(handlers.keyboardWillShow).toBeUndefined();
    const { height } = Dimensions.get('window');
    await act(() => handlers.keyboardDidShow(event(height - 320, 0)));
    expect(result.current).toEqual({ overlap: 320, duration: 0 });
    await act(() => handlers.keyboardDidHide(event(height, 0)));
    expect(result.current.overlap).toBe(0);
  });

  // A window that resizes for the keyboard ends at its top: nothing lifts twice, whether
  // it resized before the keyboard said so or after.
  it.each(['android', 'ios'] as const)(
    'reads a window already resized for the keyboard as covered by nothing (%s)',
    async (os) => {
      Platform.OS = os;
      const handlers = listen();
      const window = Dimensions.get('window');
      const top = window.height - 320;
      const { result } = await renderHook(() => useKeyboardFrame());
      const show = os === 'ios' ? handlers.keyboardWillShow : handlers.keyboardDidShow;
      try {
        await act(() => show(event(top)));
        expect(result.current.overlap).toBe(320);
        await act(async () => {
          Dimensions.set({ window: { ...window, height: top } });
        });
        expect(result.current.overlap).toBe(0);
        await act(() => show(event(top)));
        expect(result.current.overlap).toBe(0);
      } finally {
        await act(async () => {
          Dimensions.set({ window });
        });
      }
    },
  );

  it('listens to nothing on the web', async () => {
    Platform.OS = 'web';
    const handlers = listen();
    const { result } = await renderHook(() => useKeyboardFrame());
    expect(Object.keys(handlers)).toEqual([]);
    expect(result.current.overlap).toBe(0);
  });
});
