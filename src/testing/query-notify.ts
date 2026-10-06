import { notifyManager } from '@tanstack/react-query';

/**
 * Call at the top of a test file whose hooks run on a real QueryClient. React Query hands
 * results to its observers on a timer by default, so a hook's last re-render (a query or
 * mutation settling) could fall after the act() or waitFor that caused it: "An update to
 * HookContainer ... was not wrapped in act". Notifying synchronously keeps every update
 * inside the act that triggered it. Restores the default after the file.
 */
export function notifyQueriesSynchronously() {
  beforeAll(() => notifyManager.setScheduler((cb) => cb()));
  afterAll(() => notifyManager.setScheduler((cb) => setTimeout(cb, 0)));
}
