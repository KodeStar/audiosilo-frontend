import { act } from '@testing-library/react-native';

/**
 * `afterPaint` held by the test, which says when the page has painted:
 *
 *   // eslint-disable-next-line @typescript-eslint/no-require-imports
 *   jest.mock('@/lib/after-paint', () => require('@/testing/after-paint-mock'));
 *   import { paint, painted } from '@/testing/after-paint-mock';
 *
 * `painted` holds the waiting callbacks (a cancel removes its own); `paint()` runs them all
 * inside `act`. Clear it between tests (`painted.length = 0`).
 */
export const painted: (() => void)[] = [];

export function afterPaint(fn: () => void): () => void {
  painted.push(fn);
  return () => {
    const i = painted.indexOf(fn);
    if (i >= 0) painted.splice(i, 1);
  };
}

export async function paint(): Promise<void> {
  await act(async () => {
    for (const fn of painted.splice(0)) fn();
  });
}
