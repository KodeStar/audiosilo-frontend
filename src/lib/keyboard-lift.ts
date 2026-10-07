import { useEffect, useState } from 'react';
import { Keyboard, type KeyboardEvent, Platform, useWindowDimensions } from 'react-native';

/**
 * Keeping a bottom-anchored overlay (a `Sheet`, a phone dialog) above the iOS software
 * keyboard. iOS lays the keyboard over the window and does not resize it, and a
 * `KeyboardAvoidingView` inside an overlay that is absolutely positioned in a portal or a
 * `FullWindowOverlay` measures nothing useful, so the overlay lifts itself by the
 * keyboard's frame. Android resizes the window for the keyboard (`adjustResize`), so it
 * gets no lift (lifting there too would lift twice).
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
 * iOS animates it in or out (ms, to move with it). */
export type KeyboardFrame = { overlap: number; duration: number };

const HIDDEN: KeyboardFrame = { overlap: 0, duration: 0 };

/**
 * The iOS keyboard's overlap with the window, from its will-show / will-change / will-hide
 * events (so an overlay moves with it). Always 0 on Android and the web: Android resizes
 * the window instead, and the web's keyboard is the browser's business.
 */
export function useKeyboardFrame(): KeyboardFrame {
  const { height } = useWindowDimensions();
  const [frame, setFrame] = useState<KeyboardFrame>(HIDDEN);
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    const onChange = (e: KeyboardEvent) =>
      setFrame({
        overlap: keyboardOverlap(height, e.endCoordinates.screenY),
        duration: e.duration ?? 0,
      });
    const onHide = (e: KeyboardEvent) => setFrame({ overlap: 0, duration: e.duration ?? 0 });
    const subs = [
      Keyboard.addListener('keyboardWillShow', onChange),
      Keyboard.addListener('keyboardWillChangeFrame', onChange),
      Keyboard.addListener('keyboardWillHide', onHide),
    ];
    return () => subs.forEach((s) => s.remove());
  }, [height]);
  return frame;
}
