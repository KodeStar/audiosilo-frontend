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
});
