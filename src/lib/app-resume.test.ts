import { handleForeground } from './app-resume';

// babel-jest hoists jest.mock above the import, so app-resume sees these stubs at
// import time. handleForeground is pure (deps injected), but the module pulls
// expo-router, the query client, and the platform-resolved native task-removed
// binding at import - stub them to stay hermetic across jest-expo's ios/android/web.
jest.mock('expo-router', () => ({ router: { dismissAll: jest.fn(), replace: jest.fn() } }));
jest.mock('@/api/provider', () => ({ queryClient: { invalidateQueries: jest.fn() } }));
jest.mock('./task-removed', () => ({ consumeTaskRemoved: jest.fn(() => false) }));

describe('handleForeground', () => {
  it('always refreshes data on foreground', () => {
    const refresh = jest.fn();
    handleForeground({ refresh, taskWasRemoved: () => false, goHome: jest.fn() });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('resets to Home when the app was swiped away from recents', () => {
    const goHome = jest.fn();
    handleForeground({ refresh: jest.fn(), taskWasRemoved: () => true, goHome });
    expect(goHome).toHaveBeenCalledTimes(1);
  });

  it('keeps the current screen on a plain app-switch (no task removal)', () => {
    const goHome = jest.fn();
    handleForeground({ refresh: jest.fn(), taskWasRemoved: () => false, goHome });
    expect(goHome).not.toHaveBeenCalled();
  });

  it('refreshes even when resetting to Home', () => {
    const refresh = jest.fn();
    const goHome = jest.fn();
    handleForeground({ refresh, taskWasRemoved: () => true, goHome });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(goHome).toHaveBeenCalledTimes(1);
  });
});
