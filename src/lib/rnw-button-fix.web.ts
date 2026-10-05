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

// --- Space activation --------------------------------------------------------------
//
// react-native-web's PressResponder keyboard-activates a pressable on Enter, but on
// Space only when the element's role is "button" (its module-local `isValidKeyPress`).
// Two consequences, fixed here once for every pressable rather than per primitive:
//
//   1. A role-bearing control (a `tab`, `radio`, `switch`, `checkbox`, `option`, ...)
//      ignored Space, which the ARIA patterns require to activate it. Space on such an
//      element now presses it (on keyup, like a native button) and doesn't scroll.
//   2. On a role="button" pressable that has NO onPress (rn-primitives' Select trigger,
//      whose opening is Radix's own key handler on the same element), RNW still
//      preventDefault-ed Space before that handler ran, and Radix skips a
//      default-prevented event - so Space never opened it. Such a pressable now leaves
//      Space to the element's own handlers (still stopping the bubble, so an enclosing
//      pressable never sees it).
//
// We wrap the handler factory on the PressResponder prototype (every Pressable creates
// its handlers through it, lazily, after this module has run). Everything else - Enter,
// a real `<button>`, a disabled pressable, a key from a child element - goes to RNW's own
// handler unchanged.

/** The roles Space activates (ARIA: tab, radio, switch, checkbox, option, menu items). */
const SPACE_ROLES = new Set([
  'tab',
  'radio',
  'switch',
  'checkbox',
  'option',
  'menuitem',
  'menuitemradio',
  'menuitemcheckbox',
]);

type KeyEvent = {
  key: string;
  repeat?: boolean;
  target: unknown;
  currentTarget: unknown;
  preventDefault: () => void;
  stopPropagation: () => void;
};
type ResponderHandlers = { onKeyDown: (event: KeyEvent) => void } & Record<string, unknown>;
interface PressResponderInstance {
  _config: { disabled?: boolean | null; onPress?: ((event: unknown) => void) | null };
  /** The document keyup listener of a Space press still waiting for its key up. */
  __audiosiloSpaceUp?: EventListener;
}
type CreateHandlers = ((this: PressResponderInstance) => ResponderHandlers) & {
  __audiosiloSpacePatch?: boolean;
};

const isSpace = (key: string) => key === ' ' || key === 'Spacebar';
const roleOf = (el: unknown) =>
  (el as { getAttribute?: (name: string) => string | null } | null)?.getAttribute?.('role') ?? null;

const responder = require('react-native-web/dist/modules/usePressEvents/PressResponder') as {
  default: { prototype: { _createEventHandlers: CreateHandlers } };
};
const responderProto = responder.default.prototype;
const createHandlers = responderProto._createEventHandlers;

if (!createHandlers.__audiosiloSpacePatch) {
  const patched: CreateHandlers = function (this: PressResponderInstance) {
    const handlers = createHandlers.call(this);
    const rnwKeyDown = handlers.onKeyDown;
    handlers.onKeyDown = (event) => {
      const { target } = event;
      if (!isSpace(event.key) || this._config.disabled || target !== event.currentTarget) {
        return rnwKeyDown(event);
      }
      if (this._config.onPress == null) {
        // Nothing for RNW to press: leave Space to the element's own handlers.
        event.stopPropagation();
        return;
      }
      const role = roleOf(target);
      if (!role || !SPACE_ROLES.has(role)) return rnwKeyDown(event);
      event.preventDefault(); // no page scroll
      event.stopPropagation();
      if (event.repeat) return;
      // At most one pending key up per pressable: one whose key up never reached the
      // document (the window lost focus mid-press) must not fire alongside the next.
      if (this.__audiosiloSpaceUp) document.removeEventListener('keyup', this.__audiosiloSpaceUp);
      const onKeyUp = ((up: KeyEvent) => {
        if (!isSpace(up.key)) return;
        document.removeEventListener('keyup', onKeyUp);
        this.__audiosiloSpaceUp = undefined;
        if (up.target === target) this._config.onPress?.(up);
      }) as unknown as EventListener;
      this.__audiosiloSpaceUp = onKeyUp;
      document.addEventListener('keyup', onKeyUp);
    };
    return handlers;
  };
  patched.__audiosiloSpacePatch = true;
  responderProto._createEventHandlers = patched;
}
