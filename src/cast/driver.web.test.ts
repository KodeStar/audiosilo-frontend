import type { CastDriver, CastSessionEvent } from './types';

const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

const S = {
  SESSION_STARTING: 'SESSION_STARTING',
  SESSION_STARTED: 'SESSION_STARTED',
  SESSION_START_FAILED: 'SESSION_START_FAILED',
  SESSION_ENDING: 'SESSION_ENDING',
  SESSION_ENDED: 'SESSION_ENDED',
  SESSION_RESUMED: 'SESSION_RESUMED',
};

/** A Cast Web Sender stand-in: a context whose session events the test fires. */
function fakeSender() {
  let onState: ((e: { sessionState: string }) => void) | null = null;
  let session: object | null = null;
  const ctx = {
    setOptions: jest.fn(),
    addEventListener: (_t: string, fn: (e: { sessionState: string }) => void) => {
      onState = fn;
    },
    removeEventListener: jest.fn(),
    requestSession: jest.fn(async () => {
      session = makeSession();
      onState?.({ sessionState: S.SESSION_STARTING });
      onState?.({ sessionState: S.SESSION_STARTED });
    }),
    getCurrentSession: () => session,
    endCurrentSession: jest.fn((_stop: boolean) => {
      onState?.({ sessionState: S.SESSION_ENDING });
      session = null;
      onState?.({ sessionState: S.SESSION_ENDED });
    }),
  };
  const makeSession = () => ({
    loadMedia: jest.fn(),
    getMediaSession: () => null,
    getCastDevice: () => ({ friendlyName: 'Living room' }),
    sendMessage: jest.fn(),
    getSessionObj: () => ({}),
  });
  return {
    ctx,
    /** Another tab of this origin started a session: CAF joins this tab to it. */
    joinedByOrigin() {
      session = makeSession();
      onState?.({ sessionState: S.SESSION_RESUMED });
    },
  };
}

const store = new Map<string, string>();
let sender: ReturnType<typeof fakeSender>;

function installWindow() {
  sender = fakeSender();
  Object.assign(window as unknown as Record<string, unknown>, {
    isSecureContext: true,
    location: { protocol: 'https:' },
    chrome: {
      cast: {
        AutoJoinPolicy: { ORIGIN_SCOPED: 'origin_scoped' },
        media: { DEFAULT_MEDIA_RECEIVER_APP_ID: 'CC1AD845' },
      },
    },
    cast: {
      framework: {
        CastContext: { getInstance: () => sender.ctx },
        CastContextEventType: { SESSION_STATE_CHANGED: 'sessionstatechanged' },
        SessionState: S,
      },
    },
    sessionStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  });
  Object.defineProperty(window, 'navigator', {
    value: { userAgent: CHROME_UA },
    configurable: true,
  });
}

/** A fresh page (the driver's module state starts again; the tab's storage is kept). */
async function openPage(): Promise<{ driver: CastDriver; events: CastSessionEvent['type'][] }> {
  installWindow();
  let driver!: CastDriver;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    driver = require('./driver.web').castDriver;
  });
  const events: CastSessionEvent['type'][] = [];
  driver.subscribe((e) => events.push(e.type));
  expect(await driver.init()).toBe(true);
  return { driver, events };
}

const originalNavigator = Object.getOwnPropertyDescriptor(window, 'navigator');
// The sender is already on the page (`cast.framework`), so nothing is loaded into it.
(globalThis as Record<string, unknown>).document = {};
beforeEach(() => store.clear());
afterAll(() => {
  if (originalNavigator) Object.defineProperty(window, 'navigator', originalNavigator);
  delete (globalThis as Record<string, unknown>).document;
});

it('finding 8: never follows a session another tab started (leaves it, the receiver plays on)', async () => {
  const { events } = await openPage();
  sender.joinedByOrigin();
  expect(events).toEqual([]);
  expect(sender.ctx.endCurrentSession).toHaveBeenCalledWith(false);
});

it('follows the session this tab started, and finds it again after a reload of this tab', async () => {
  const first = await openPage();
  await first.driver.requestSession!();
  expect(first.events).toEqual(['starting', 'started']);
  // The page reloads mid-cast: the sender rejoins the origin's session, which is this tab's.
  const again = await openPage();
  sender.joinedByOrigin();
  expect(again.events).toEqual(['resumed']);
  expect(sender.ctx.endCurrentSession).not.toHaveBeenCalled();
  // Once it ends here, a later reload no longer counts it as this tab's.
  await again.driver.endSession(true);
  expect(again.events).toEqual(['resumed', 'ending', 'ended']);
  const later = await openPage();
  sender.joinedByOrigin();
  expect(later.events).toEqual([]);
});
