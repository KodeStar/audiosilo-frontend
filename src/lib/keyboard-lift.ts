import { useEffect, useMemo, useState } from 'react';
import { Keyboard, type KeyboardEvent, Platform, useWindowDimensions } from 'react-native';

/**
 * Keeping a bottom-anchored overlay (a `Sheet`, a phone dialog) above the software
 * keyboard. A `KeyboardAvoidingView` inside an overlay that is absolutely positioned in a
 * portal or a `FullWindowOverlay` measures nothing useful, so the overlay lifts itself by
 * how much of the WINDOW the keyboard covers: the keyboard's top edge in screen
 * coordinates against the window's height, on every platform. iOS lays the keyboard over
 * the window, so that is the keyboard. Android resizes the window for it only when the app
 * is not edge to edge (`adjustResize`); edge to edge (SDK 56, Android 15+) the window
 * keeps its height and the keyboard lies over it like iOS. A window that did resize ends
 * at the keyboard's top, so the same sum gives about 0 there and nothing lifts twice.
 */

/** The smallest gap kept between a capped panel and the top safe edge, in points. */
export const KEYBOARD_TOP_GAP = 8;

/** How much of the window (its height) the keyboard covers, from the keyboard frame's top
 * edge (`endCoordinates.screenY`): the whole software keyboard, just the bar of a hardware
 * keyboard, nothing once it has gone below the window. Pure. */
export function keyboardOverlap(windowHeight: number, keyboardTop: number): number {
  return Math.max(0, Math.round(windowHeight - keyboardTop));
}

/** How far a panel that pads itself for the home indicator (`bottomInset`) rises so its
 * bottom edge meets the keyboard: the keyboard covers the home indicator too. Pure. */
export function keyboardLift(overlap: number, bottomInset: number): number {
  return Math.max(0, overlap - Math.max(0, bottomInset));
}

/**
 * A panel's height cap with the keyboard up: its usual share of the window
 * (`windowHeight * fraction`), but never taller than what the keyboard leaves under the
 * top safe edge, so the title stays on screen and the body scrolls instead. Pure.
 */
export function keyboardCap(opts: {
  windowHeight: number;
  fraction: number;
  overlap: number;
  topInset: number;
}): number {
  const { windowHeight, fraction, overlap, topInset } = opts;
  const usual = Math.round(windowHeight * fraction);
  if (overlap <= 0) return usual;
  return Math.max(0, Math.min(usual, windowHeight - overlap - topInset - KEYBOARD_TOP_GAP));
}

/** The keyboard as an overlay sees it: how much of the window it covers, and how long
 * it animates in or out (ms, to move with it; 0 on Android, which says so after). */
export type KeyboardFrame = { overlap: number; duration: number };

/** The keyboard's top edge in screen coordinates (null: none up), and its animation. */
type KeyboardTop = { top: number | null; duration: number };

const HIDDEN: KeyboardTop = { top: null, duration: 0 };

/** The keyboard events each platform sends: iOS says what is about to happen (so an
 * overlay moves with it), Android what did. */
const EVENTS = {
  ios: {
    show: ['keyboardWillShow', 'keyboardWillChangeFrame'],
    hide: 'keyboardWillHide',
  },
  android: { show: ['keyboardDidShow'], hide: 'keyboardDidHide' },
} as const;

/**
 * The keyboard's overlap with the window while `active` (an overlay that is open), on iOS
 * and Android (`EVENTS`), seeded from a keyboard already up when it becomes active. The
 * keyboard's top edge is kept and set against the window's height as it is at each
 * render, so a window that resizes for the keyboard after the event (Android without edge
 * to edge) reads as covered by nothing. A closed overlay listens to nothing, and an event
 * that leaves the top as it was (will-show and will-change both fire for one rise)
 * changes nothing. Always 0 on the web, whose keyboard is the browser's business.
 */
export function useKeyboardFrame(active = true): KeyboardFrame {
  const { height } = useWindowDimensions();
  const [frame, setFrame] = useState<KeyboardTop>(HIDDEN);
  useEffect(() => {
    const events = Platform.OS === 'ios' || Platform.OS === 'android' ? EVENTS[Platform.OS] : null;
    if (!events || !active) return;
    const set = (top: number | null, duration: number) =>
      setFrame((prev) => (prev.top === top ? prev : { top, duration }));
    const up = Keyboard.metrics();
    if (up) set(up.screenY, 0);
    const onShow = (e: KeyboardEvent) => set(e.endCoordinates.screenY, e.duration ?? 0);
    const onHide = (e: KeyboardEvent) => set(null, e.duration ?? 0);
    const subs = [
      ...events.show.map((name) => Keyboard.addListener(name, onShow)),
      Keyboard.addListener(events.hide, onHide),
    ];
    return () => {
      subs.forEach((s) => s.remove());
      // Closed: the next open starts from the keyboard as it is then.
      setFrame(HIDDEN);
    };
  }, [active]);
  return useMemo(
    () => ({
      overlap: frame.top === null ? 0 : keyboardOverlap(height, frame.top),
      duration: frame.duration,
    }),
    [frame, height],
  );
}

/** What a bottom-anchored panel does about the keyboard (`useKeyboardAvoidance`). */
export type KeyboardAvoidance = {
  /** How far the panel rises (`keyboardLift`). */
  lift: number;
  /** The panel's height cap (`keyboardCap`). */
  cap: number;
  /** How long the keyboard animates, in ms, to move with it. */
  duration: number;
};

/**
 * The keyboard as a bottom-anchored panel (a `Sheet`, a phone dialog) answers it while
 * `active` (open): it rises above a keyboard lying over the window (`lift`), and its
 * height is capped to its usual `fraction` of the window and to what the keyboard leaves
 * under the top safe edge (`cap`), so its title stays on screen. No lift and the usual
 * cap where the keyboard covers nothing (a window resized for it, the web).
 */
export function useKeyboardAvoidance(opts: {
  active: boolean;
  fraction: number;
  bottomInset: number;
  topInset: number;
}): KeyboardAvoidance {
  const { height } = useWindowDimensions();
  const { overlap, duration } = useKeyboardFrame(opts.active);
  return {
    lift: keyboardLift(overlap, opts.bottomInset),
    cap: keyboardCap({
      windowHeight: height,
      fraction: opts.fraction,
      overlap,
      topInset: opts.topInset,
    }),
    duration,
  };
}
