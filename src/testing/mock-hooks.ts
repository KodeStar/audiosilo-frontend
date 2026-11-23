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
 * Makes a mocked hook re-render its caller when the test says its answer changed, as the
 * real one does (a React Query observer, a store, expo-router's params). A mock that only
 * reads the test's variables is read again when something else renders its caller, and
 * with the React Compiler (which Jest builds the app with, as it ships) a `rerender` with
 * the same props reaches only the root: every child's element is memoised against its
 * props. Call it first in the mocked hook, from the factory:
 *
 *     useServerInfo: () => {
 *       jest.requireActual<typeof import('@/testing/mock-hooks')>('@/testing/mock-hooks')
 *         .useMockedHook();
 *       return { data: mockInfo };
 *     },
 */
export function useMockedHook(): void {
  useSyncExternalStore(subscribe, read);
}

/** Re-renders every component a mocked hook ({@link useMockedHook}) is in, once the test
 * has changed what the mocks answer. */
export async function mocksChanged(): Promise<void> {
  await act(() => {
    version += 1;
    for (const listener of listeners) listener();
  });
}
