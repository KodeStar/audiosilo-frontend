import { useLayoutEffect, useRef, useState } from 'react';
import { type LayoutChangeEvent, Platform, type View } from 'react-native';

/**
 * A view's width, for a layout that divides it (a cover grid's columns): `0` until
 * measured, then kept current by `onLayout`. On the web it is read before the first paint
 * too (the element's `offsetWidth`, as react-native-web's own `onLayout` reads it, in a
 * layout effect), so what depends on it draws in the same frame rather than one
 * `onLayout` later. Native waits for `onLayout`, as before. Give the view `ref` and
 * `onLayout`.
 */
export function useWidth() {
  const ref = useRef<View>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (Platform.OS !== 'web') return;
    const w = (ref.current as unknown as { offsetWidth?: number } | null)?.offsetWidth;
    if (w) setWidth(w);
  }, []);
  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);
  return { ref, width, onLayout };
}
