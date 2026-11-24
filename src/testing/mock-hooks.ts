import { act } from '@testing-library/react-native';
import { useSyncExternalStore } from 'react';

const listeners = new Set<() => void>();
let version = 0;

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const read = () => version;

/**
 * A mocked hook that re-renders its caller when the test says its answer changed
 * ({@link mocksChanged}), as the real one does (a React Query observer, a store,
 * expo-router's params). A mock that only reads the test's variables is read again only
 * when something else renders its caller, and with the React Compiler (which Jest builds
 * the app with, as it ships) a `rerender` with the same props reaches only the root: every
 * child's element is memoised against its props. In a jest.mock factory:
 *
 *     // `require` because a jest.mock factory is hoisted above every import.
 *     // eslint-disable-next-line @typescript-eslint/no-require-imports
 *     const { mockedHook } = require('@/testing/mock-hooks');
 *     return { useServerInfo: mockedHook(() => ({ data: mockInfo })) };
 */
export function mockedHook<A extends unknown[], R>(hook: (...args: A) => R): (...args: A) => R {
  return (...args) => {
    useSyncExternalStore(subscribe, read);
    return hook(...args);
  };
}

/** Re-renders every component a {@link mockedHook} is in, once the test has changed what
 * the mocks answer. */
export async function mocksChanged(): Promise<void> {
  await act(() => {
    version += 1;
    for (const listener of listeners) listener();
  });
}
