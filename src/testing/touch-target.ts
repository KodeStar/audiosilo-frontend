import { type Insets, StyleSheet } from 'react-native';

/** Points per rem on iOS and Android (`polyfills.rem` in `uniwind.config.js`). */
const NATIVE_REM = 14;

/** The largest size class on `axis` in `className` (`h-11`, `min-w-9`, `h-[38px]`), in
 * native points, or null when the class sets none (a pill sized by its text). */
function classSize(className: string, axis: 'h' | 'w'): number | null {
  const re = new RegExp(
    `^(?:min-)?(?:${axis}|size)-(?:\\[(\\d+(?:\\.\\d+)?)px\\]|(\\d+(?:\\.\\d+)?))$`,
  );
  let size: number | null = null;
  for (const token of className.split(/\s+/)) {
    const m = re.exec(token);
    if (!m) continue;
    const pt = m[1] !== undefined ? Number(m[1]) : (Number(m[2]) / 4) * NATIVE_REM;
    size = Math.max(size ?? 0, pt);
  }
  return size;
}

/**
 * A control's touch target on iOS and Android, in points: its size (a numeric style, else
 * its size classes at a 14 pt rem) plus its hit slop on both sides. A side the control
 * does not size (a text pill's width) is null. For the 44 pt rule (STYLEGUIDE section 14),
 * which rem-sized classes break silently on native: `h-11` is 44 px on the web but 38.5 pt
 * on a phone.
 */
export function nativeTarget(el: { props: Record<string, unknown> }): {
  width: number | null;
  height: number | null;
} {
  const className = String(el.props.className ?? '');
  const style = (StyleSheet.flatten(el.props.style as never) ?? {}) as {
    width?: unknown;
    height?: unknown;
  };
  const raw = el.props.hitSlop as number | Insets | undefined;
  const slop: Insets =
    typeof raw === 'number' ? { top: raw, bottom: raw, left: raw, right: raw } : (raw ?? {});
  const side = (styled: unknown, axis: 'h' | 'w') =>
    typeof styled === 'number' ? styled : classSize(className, axis);
  const h = side(style.height, 'h');
  const w = side(style.width, 'w');
  return {
    height: h === null ? null : h + (slop.top ?? 0) + (slop.bottom ?? 0),
    width: w === null ? null : w + (slop.left ?? 0) + (slop.right ?? 0),
  };
}

/** Asserts a control takes at least a 44 pt touch on native (each side it sizes). */
export function expectNativeTarget(el: { props: Record<string, unknown> }) {
  const { width, height } = nativeTarget(el);
  expect(height).not.toBeNull();
  expect(height).toBeGreaterThanOrEqual(44);
  if (width !== null) expect(width).toBeGreaterThanOrEqual(44);
}
