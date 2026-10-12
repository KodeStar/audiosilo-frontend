import { useLayoutEffect, useRef, useState } from 'react';
import { Keyboard, Platform, TextInput } from 'react-native';

/**
 * Give the software keyboard up: blur the focused field (React Native's own record of it,
 * `TextInput.State`, where the build has it), then `Keyboard.dismiss()`. Native only: on
 * the web a removed field takes the browser's keyboard with it, and blurring first would
 * fight the dialog's own focus return.
 */
export function releaseKeyboard(): void {
  if (Platform.OS === 'web') return;
  const state = TextInput.State;
  const focused = state?.currentlyFocusedInput?.();
  if (focused) state.blurTextInput?.(focused);
  Keyboard.dismiss();
}

/**
 * The shared overlays' close (the Dialog, the Sheet): returns whether to keep the content
 * mounted. When `open` turns false the content stays for ONE more commit, in which the
 * keyboard is released (`releaseKeyboard`) while the focused field is still on screen;
 * the next commit unmounts it.
 *
 * Why: a focused field removed with the keyboard up left the keyboard showing on Android
 * (the window's fallback input, a full QWERTY keyboard with no field) over the screen
 * under the overlay, e.g. after a right PIN, over "Who's listening?" and then Home. Every
 * way an overlay closes (its buttons, the close button, the backdrop, Android's back, a
 * caller turning `open` off) comes through here.
 *
 * An overlay unmounted while open (its screen navigated away) releases it as it goes.
 *
 * State only (no refs read in render), set from a layout effect: the extra commit happens
 * before paint, and a lost update only loses the hold, never an open.
 */
export function useReleaseOnClose(open: boolean): boolean {
  const [wasOpen, setWasOpen] = useState(open);
  // Taken away while open (its screen navigated away under it): released on the way out.
  // A portaled dialog's content leaves in a later commit than this, so it is still there.
  const openNow = useRef(open);
  useLayoutEffect(() => {
    openNow.current = open;
  });
  useLayoutEffect(
    () => () => {
      if (openNow.current) releaseKeyboard();
    },
    [],
  );
  useLayoutEffect(() => {
    if (open === wasOpen) return;
    if (!open) releaseKeyboard();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the second commit IS the point: the field is removed only after the release above
    setWasOpen(open);
  }, [open, wasOpen]);
  return open || wasOpen;
}
