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

describe('rnw-button-fix (web): Space activation', () => {
  type Listener = (event: unknown) => void;
  const PressResponder = (
    require('react-native-web/dist/modules/usePressEvents/PressResponder') as {
      default: new (config: object) => {
        getEventHandlers: () => { onKeyDown: (event: object) => void };
      };
    }
  ).default;

  let keyups: Listener[] = [];
  const realDocument = (globalThis as { document?: unknown }).document;
  beforeAll(() => {
    require('./rnw-button-fix.web');
    (globalThis as { document?: unknown }).document = {
      addEventListener: (type: string, fn: Listener) => type === 'keyup' && keyups.push(fn),
      removeEventListener: (type: string, fn: Listener) => {
        keyups = keyups.filter((l) => l !== fn);
      },
    };
  });
  afterAll(() => {
    (globalThis as { document?: unknown }).document = realDocument;
  });
  beforeEach(() => {
    keyups = [];
  });

  const element = (role: string) => ({
    getAttribute: (name: string) => (name === 'role' ? role : null),
  });
  const keyDown = (el: object, extra: object = {}) => ({
    key: ' ',
    target: el,
    currentTarget: el,
    preventDefault: jest.fn(),
    stopPropagation: jest.fn(),
    persist: jest.fn(),
    ...extra,
  });
  const keyUp = (el: object) => {
    for (const l of [...keyups]) l({ key: ' ', target: el });
  };

  it.each(['tab', 'radio', 'switch', 'option'])(
    'presses a role="%s" pressable on Space (on keyup) without scrolling',
    (role) => {
      const onPress = jest.fn();
      const el = element(role);
      const event = keyDown(el);
      new PressResponder({ onPress }).getEventHandlers().onKeyDown(event);
      expect(event.preventDefault).toHaveBeenCalled();
      expect(onPress).not.toHaveBeenCalled();
      keyUp(el);
      expect(onPress).toHaveBeenCalledTimes(1);
      expect(keyups).toHaveLength(0);
    },
  );

  it('ignores the auto-repeat of a held Space', () => {
    const onPress = jest.fn();
    const el = element('tab');
    const handlers = new PressResponder({ onPress }).getEventHandlers();
    handlers.onKeyDown(keyDown(el));
    handlers.onKeyDown(keyDown(el, { repeat: true }));
    keyUp(el);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('fires once after a Space whose key up never reached the document', () => {
    // The window lost focus mid-press: its key up went elsewhere. The next full press
    // must fire onPress once, not once per stranded listener.
    const onPress = jest.fn();
    const el = element('tab');
    const handlers = new PressResponder({ onPress }).getEventHandlers();
    handlers.onKeyDown(keyDown(el));
    expect(keyups).toHaveLength(1);
    handlers.onKeyDown(keyDown(el));
    expect(keyups).toHaveLength(1);
    keyUp(el);
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(keyups).toHaveLength(0);
  });

  it('leaves Space to the element itself when there is nothing to press (a Select trigger)', () => {
    const el = element('button');
    const event = keyDown(el);
    new PressResponder({}).getEventHandlers().onKeyDown(event);
    // Not default-prevented, so Radix's own handler (which skips prevented events) opens it.
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(keyups).toHaveLength(0);
  });

  it('does nothing on a disabled pressable', () => {
    const onPress = jest.fn();
    const el = element('tab');
    const event = keyDown(el);
    new PressResponder({ onPress, disabled: true }).getEventHandlers().onKeyDown(event);
    keyUp(el);
    expect(onPress).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});
