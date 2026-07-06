/* eslint-disable @typescript-eslint/no-require-imports */
// The web patch (`rnw-button-fix.web.ts`) intercepts react-native-web's
// role->element mapping so `role="button"` / `accessibilityRole="button"` render as
// `<div role="button">` instead of a real `<button>` (which nests illegally and hits
// an older-Safari flex-in-button bug). We assert the mapping directly on RNW's
// `AccessibilityUtil` singleton - the same object `createElement` consults at render
// time - so a regression that reintroduces the `<button>` tag fails here.
const AccessibilityUtil = (
  require('react-native-web/dist/modules/AccessibilityUtil') as {
    default: { propsToAccessibilityComponent: (p: Record<string, unknown>) => string | undefined };
  }
).default;

type RoleProps = Record<string, unknown>;
const mapOf = (props: RoleProps): string | undefined =>
  AccessibilityUtil.propsToAccessibilityComponent(props);

describe('rnw-button-fix (web)', () => {
  it('maps role="button" to a real <button> before the patch is applied', () => {
    expect(mapOf({ role: 'button' })).toBe('button');
    expect(mapOf({ accessibilityRole: 'button' })).toBe('button');
  });

  it('keeps role="button" on the base <div> after the patch, preserving other roles', () => {
    // Applying the side-effect patch mutates the shared AccessibilityUtil singleton.
    require('./rnw-button-fix.web');

    // Button no longer resolves to a DOM component => stays the base <div>, which
    // still receives role="button" + tabIndex from createDOMProps.
    expect(mapOf({ role: 'button' })).toBeUndefined();
    expect(mapOf({ accessibilityRole: 'button' })).toBeUndefined();

    // Non-button roles are untouched.
    expect(mapOf({ role: 'list' })).toBe('ul');
    expect(mapOf({ role: 'heading', 'aria-level': 2 })).toBe('h2');
    // Link already stayed a <div> in RNW (no roleComponents entry) - unchanged.
    expect(mapOf({ role: 'link' })).toBeUndefined();
  });

  it('is idempotent: re-evaluating the module does not double-wrap', () => {
    const patched = AccessibilityUtil.propsToAccessibilityComponent;
    // isolateModules forces the module body to run again; the guard must detect the
    // already-patched singleton and leave the wrapper untouched.
    jest.isolateModules(() => {
      require('./rnw-button-fix.web');
    });
    expect(AccessibilityUtil.propsToAccessibilityComponent).toBe(patched);
    expect(mapOf({ role: 'button' })).toBeUndefined();
  });
});
