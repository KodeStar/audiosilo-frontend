import { renderHook } from '@testing-library/react-native';

import { ApiError } from '@/api/client';

let mockDeviceOnline = true;
jest.mock('./device-online', () => ({
  ...jest.requireActual('./device-online'),
  useDeviceOnline: () => mockDeviceOnline,
}));

/* eslint-disable import/first */
import { offlineState, useUnreadQuery } from './offline-state';
/* eslint-enable import/first */

describe('offlineState (the one offline rule: Home, the Library, Folders, the read-along map)', () => {
  const read = { waiting: false, failed: false };

  it('says nothing of what was read or is still on its way', () => {
    expect(offlineState({ ...read, deviceOnline: true })).toBeNull();
    // No network on the device, but nothing was asked that is missing.
    expect(offlineState({ ...read, deviceOnline: false })).toBeNull();
  });

  it('is offline while the request waits for the network, whatever the device says yet', () => {
    expect(offlineState({ waiting: true, failed: false, deviceOnline: false })).toBe('offline');
    // The query library holds it before the device signal has caught up.
    expect(offlineState({ waiting: true, failed: false, deviceOnline: true })).toBe('offline');
  });

  it('is offline, not failed, when it failed with no network on the device (no Retry)', () => {
    expect(offlineState({ waiting: false, failed: true, deviceOnline: false })).toBe('offline');
  });

  // fe#179: a server on the same Wi-Fi with the internet down. The device has a network,
  // so the failure is the server's and its Retry stays.
  it('is failed, with a Retry, when it failed with a network on the device', () => {
    expect(offlineState({ waiting: false, failed: true, deviceOnline: true })).toBe('failed');
  });
});

// One page or list over one query (the Library's Series, Authors, Narrators, Collections
// and Shows modes; the series, person, book, collection, show and folder pages). A query
// held for the network stays pending: a skeleton drawn for that never ended.
describe('useUnreadQuery', () => {
  const down = new TypeError('Network request failed');
  const read = { data: undefined as unknown, isPaused: false, error: null as unknown };
  const ask = async (query: typeof read, deviceOnline = true) => {
    mockDeviceOnline = deviceOnline;
    return (await renderHook(() => useUnreadQuery(query))).result.current;
  };

  it('is offline while the query waits for the network', async () => {
    expect(await ask({ ...read, isPaused: true })).toBe('offline');
    expect(await ask({ ...read, isPaused: true }, false)).toBe('offline');
  });

  it('is offline when it failed with no network on the device, failed with one', async () => {
    expect(await ask({ ...read, error: down }, false)).toBe('offline');
    expect(await ask({ ...read, error: down })).toBe('failed');
  });

  it('says nothing while it loads, or once it holds data (shown whatever the network)', async () => {
    expect(await ask(read)).toBeNull();
    expect(await ask(read, false)).toBeNull();
    expect(await ask({ ...read, data: [], isPaused: true, error: down }, false)).toBeNull();
  });

  // The server answered (signed out, not in the library): the screen's own state for
  // that stands, whatever the network did since.
  it("never calls a server's refusal offline", async () => {
    for (const status of [401, 403, 404]) {
      const refused = { ...read, error: new ApiError(status, 'no') };
      expect(await ask(refused, false)).toBe('failed');
      expect(await ask({ ...refused, isPaused: true }, false)).toBe('failed');
    }
  });
});
