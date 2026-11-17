// React Query's online flag on the web, as the provider wires it while it is imported: its
// own module registry per test, so each one sees the wiring of a fresh start.

type Online = { isOnline: () => boolean };

const g = globalThis as unknown as { window?: unknown; navigator?: unknown };
const saved = { window: g.window, navigator: g.navigator };
afterEach(() => {
  g.window = saved.window;
  Object.defineProperty(globalThis, 'navigator', { value: saved.navigator, configurable: true });
});

/** Imports the provider on the web in a browser that says `onLine`, and hands back React
 * Query's online flag and the browser's `online` / `offline` events. */
function startWeb(onLine: boolean) {
  const handlers: Record<string, (() => void)[]> = {};
  g.window = {
    addEventListener: (type: string, cb: () => void) => (handlers[type] ??= []).push(cb),
    removeEventListener: jest.fn(),
  };
  const nav = { onLine };
  Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true });
  let manager: Online | undefined;
  jest.isolateModules(() => {
    const { Platform } = jest.requireActual<typeof import('react-native')>('react-native');
    Platform.OS = 'web';
    jest.requireActual('./provider');
    manager = jest.requireActual<{ onlineManager: Online }>('@tanstack/react-query').onlineManager;
  });
  const fire = (type: 'online' | 'offline') => {
    nav.onLine = type === 'online';
    for (const cb of handlers[type] ?? []) cb();
  };
  return { manager: manager!, fire };
}

describe("the web's online flag (fe#271)", () => {
  // TanStack's own listener starts online and hears only the events: a cold launch with no
  // network asked every read, and a page that mounts a reader of a failed one asked it again.
  it('starts from the browser saying it is offline', () => {
    const { manager } = startWeb(false);
    expect(manager.isOnline()).toBe(false);
  });

  it("follows the browser's online and offline events", () => {
    const { manager, fire } = startWeb(false);
    fire('online');
    expect(manager.isOnline()).toBe(true);
    fire('offline');
    expect(manager.isOnline()).toBe(false);
  });

  it('starts online when the browser says so', () => {
    const { manager } = startWeb(true);
    expect(manager.isOnline()).toBe(true);
  });
});
