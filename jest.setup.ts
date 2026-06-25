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
