import { NativeModules, Platform } from 'react-native';
import GoogleCast from 'react-native-google-cast';

import { castDriver } from './driver.native';

// The JS bundle can be newer than the installed binary: a store build from before casting
// has no Cast module, and the driver must then do nothing at all (no button, no calls).
describe('the native Cast driver on a binary without the Cast module', () => {
  it('is unsupported, listens to nothing and has no session', async () => {
    expect(NativeModules.RNGCCastContext).toBeUndefined();
    await expect(castDriver.supported()).resolves.toBe(false);
    await expect(castDriver.init()).resolves.toBe(false);
    expect(castDriver.subscribe(() => {})).toEqual(expect.any(Function));
    await expect(castDriver.current()).resolves.toBeNull();
    await expect(castDriver.endSession(true)).resolves.toBeUndefined();
  });
});

describe('the native Cast driver on a binary with it', () => {
  beforeEach(() => {
    NativeModules.RNGCCastContext = {};
    NativeModules.RNGCRemoteMediaClient = {};
  });
  afterEach(() => {
    delete NativeModules.RNGCCastContext;
    delete NativeModules.RNGCRemoteMediaClient;
    Platform.OS = 'ios';
  });

  it('is supported on iOS', async () => {
    Platform.OS = 'ios';
    await expect(castDriver.supported()).resolves.toBe(true);
  });

  it('is supported on Android only with Google Play services', async () => {
    Platform.OS = 'android';
    await expect(castDriver.supported()).resolves.toBe(true); // the mock reports success
    const spy = jest
      .spyOn(GoogleCast, 'getPlayServicesState')
      .mockResolvedValueOnce('missing' as never);
    await expect(castDriver.supported()).resolves.toBe(false);
    spy.mockRestore();
  });

  it("S-3: a start reported after its session ended is dropped (never a stale 'connected')", async () => {
    const on: Record<string, (...a: unknown[]) => void> = {};
    const sm = GoogleCast.getSessionManager() as unknown as Record<string, unknown>;
    const names = [
      'onSessionStarting',
      'onSessionStarted',
      'onSessionResumed',
      'onSessionStartFailed',
      'onSessionSuspended',
      'onSessionEnding',
      'onSessionEnded',
    ];
    const saved = names.map((n) => sm[n]);
    for (const n of names) {
      sm[n] = (fn: (...a: unknown[]) => void) => {
        on[n] = fn;
        return { remove() {} };
      };
    }
    try {
      const events: string[] = [];
      const off = castDriver.subscribe((e) => events.push(e.type));
      let name!: (d: { friendlyName: string }) => void;
      const session = { getCastDevice: () => new Promise((r) => (name = r)) };
      on.onSessionStarted(session);
      on.onSessionEnded(session, undefined); // ended while its device name was being read
      name({ friendlyName: 'TV' });
      await new Promise((r) => setTimeout(r, 0));
      expect(events).toEqual(['ended']);
      // A start that is not overtaken is reported as before.
      const next = { getCastDevice: async () => ({ friendlyName: 'TV' }) };
      on.onSessionStarted(next);
      await new Promise((r) => setTimeout(r, 0));
      expect(events).toEqual(['ended', 'started']);
      off();
    } finally {
      names.forEach((n, i) => (sm[n] = saved[i]));
    }
  });
});
