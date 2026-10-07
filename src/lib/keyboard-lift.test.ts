import { act, renderHook } from '@testing-library/react-native';
import { Dimensions, Keyboard, type KeyboardEvent, Platform } from 'react-native';

import {
  KEYBOARD_TOP_GAP,
  keyboardCap,
  keyboardLift,
  keyboardOverlap,
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

  // Android resizes the window for the keyboard: lifting too would lift twice.
  it('never lifts on Android', async () => {
    Platform.OS = 'android';
    const handlers = listen();
    const { result } = await renderHook(() => useKeyboardFrame());
    expect(handlers.keyboardWillShow).toBeUndefined();
    expect(handlers.keyboardDidShow).toBeUndefined();
    expect(result.current.overlap).toBe(0);
  });
});
