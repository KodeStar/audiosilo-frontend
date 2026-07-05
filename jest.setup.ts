// Global test setup: in-memory mocks for the native storage modules, so the
// storage / session / sync layers run unchanged without a device or browser.

// Initialise i18next (English) so components using `useTranslation` and the
// locale-aware formatters resolve strings under the fallback catalog in tests.
import '@/i18n';

// React 19 gates act(...) support behind this flag; @testing-library/react-native's
// render/renderHook need it so component + hook tests flush state updates. The
// pure-logic suites are unaffected (they render nothing).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem: jest.fn((k: string) => Promise.resolve(store.has(k) ? store.get(k)! : null)),
      setItem: jest.fn((k: string, v: string) => {
        store.set(k, v);
        return Promise.resolve();
      }),
      removeItem: jest.fn((k: string) => {
        store.delete(k);
        return Promise.resolve();
      }),
      clear: jest.fn(() => {
        store.clear();
        return Promise.resolve();
      }),
    },
  };
});

// react-native-reanimated 4's own `mock` entry imports the real index, which
// eagerly initialises the native Worklets module and throws under Node. So we
// provide a small self-contained mock: animations resolve synchronously (timing
// callbacks fire with `finished: true`) so the UI primitives' enter/exit logic is
// deterministic in tests, and `Animated.*` map to plain RN components. Reduced
// motion defaults to false; a test can flip it via
// `(useReducedMotion as jest.Mock).mockReturnValue(true)`.
jest.mock('react-native-reanimated', () => {
  const { View, Text, ScrollView } = require('react-native');
  const identity = <T>(v: T) => v;
  const easingCurve = (t: number) => t;
  const easingFactory = () => easingCurve;
  const Easing = {
    linear: easingCurve,
    ease: easingCurve,
    quad: easingCurve,
    cubic: easingCurve,
    in: easingFactory,
    out: easingFactory,
    inOut: easingFactory,
    bezier: () => ({ factory: easingFactory }),
  };
  return {
    __esModule: true,
    default: { View, Text, ScrollView, createAnimatedComponent: identity },
    View,
    Text,
    ScrollView,
    createAnimatedComponent: identity,
    useSharedValue: <V>(init: V) => ({ value: init }),
    useAnimatedStyle: (fn: () => unknown) => (typeof fn === 'function' ? fn() : {}),
    useDerivedValue: (fn: () => unknown) => ({
      value: typeof fn === 'function' ? fn() : undefined,
    }),
    useReducedMotion: jest.fn(() => false),
    withTiming: (to: unknown, _c?: unknown, cb?: (finished: boolean) => void) => {
      if (typeof cb === 'function') cb(true);
      return to;
    },
    withSpring: (to: unknown, _c?: unknown, cb?: (finished: boolean) => void) => {
      if (typeof cb === 'function') cb(true);
      return to;
    },
    withDelay: (_d: number, anim: unknown) => anim,
    withRepeat: (anim: unknown) => anim,
    withSequence: (...anims: unknown[]) => anims[anims.length - 1],
    cancelAnimation: () => {},
    runOnJS:
      <A extends unknown[]>(fn: (...args: A) => unknown) =>
      (...args: A) =>
        fn(...args),
    runOnUI:
      <A extends unknown[]>(fn: (...args: A) => unknown) =>
      (...args: A) =>
        fn(...args),
    interpolate: (x: number) => x,
    Extrapolation: { CLAMP: 'clamp', EXTEND: 'extend', IDENTITY: 'identity' },
    Easing,
    ReduceMotion: { System: 'system', Never: 'never', Always: 'always' },
  };
});

jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    getItemAsync: jest.fn((k: string) => Promise.resolve(store.has(k) ? store.get(k)! : null)),
    setItemAsync: jest.fn((k: string, v: string) => {
      store.set(k, v);
      return Promise.resolve();
    }),
    deleteItemAsync: jest.fn((k: string) => {
      store.delete(k);
      return Promise.resolve();
    }),
  };
});
