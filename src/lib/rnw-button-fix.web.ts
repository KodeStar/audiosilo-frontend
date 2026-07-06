/* eslint-disable @typescript-eslint/no-require-imports */
// react-native-web maps `accessibilityRole="button"` / `role="button"` to a real
// `<button>` DOM element (its internal `roleComponents` table in
// `propsToAccessibilityComponent`). On web that bites us two ways:
//
//   1. Illegal nesting. A card pressable (`role="button"`) that contains a heart,
//      overflow ("…") or play button is a `<button>` inside a `<button>` - invalid
//      HTML. React 19 throws "In HTML, <button> cannot be a descendant of <button>"
//      and, worse, the browser's parser restructures the SSR'd static-export markup,
//      breaking hydration.
//   2. Safari flex bug. WebKit before ~17.4 ignores `display:flex` on a `<button>`
//      (a long-standing bug), so our flex-row rows/cards collapse to a vertical
//      stack and centered leaf buttons (play, 15s/30s) lose their layout/background.
//      Chromium and modern Safari are unaffected - which is exactly why the breakage
//      only reproduced on older iPhones and never on desktop Chrome / Playwright
//      Chromium.
//
// Fix (web only): intercept the role->element mapping so `role="button"` renders on
// the base `<div>` instead of `<button>`. react-native-web still emits `role="button"`
// and `tabIndex=0` (from `createDOMProps`), and its `PressResponder` keyboard-activates
// a `role="button"` div (Enter always; Space because the live DOM `role` attribute is
// "button"). So focus order, keyboard activation, and the AT-exposed button role are
// all preserved - only the tag changes from `<button>` to `<div role="button">`. Divs
// nest legally and flex correctly on every WebKit version. This is a single global
// seam, so it covers every pressable (AnimatedPressable, raw Pressable, Button) with
// no call-site churn.
//
// We mutate the singleton `AccessibilityUtil` object that
// `react-native-web/dist/exports/createElement` imports and calls at render time
// (`AccessibilityUtil.propsToAccessibilityComponent(props)`), so patching the property
// is enough - createElement reads the live value. Heading/list/etc. mappings are left
// untouched; only `'button'` is intercepted.

type AriaProps = Record<string, unknown> | undefined;
interface AccessibilityUtilModule {
  propsToAccessibilityComponent: ((props?: AriaProps) => string | undefined) & {
    __audiosiloButtonPatch?: boolean;
  };
}

const mod = require('react-native-web/dist/modules/AccessibilityUtil') as {
  default: AccessibilityUtilModule;
};
const AccessibilityUtil = mod.default;

const original = AccessibilityUtil.propsToAccessibilityComponent;
if (!original.__audiosiloButtonPatch) {
  const patched = (props?: AriaProps) => {
    const component = original(props);
    return component === 'button' ? undefined : component;
  };
  patched.__audiosiloButtonPatch = true;
  AccessibilityUtil.propsToAccessibilityComponent = patched;
}
