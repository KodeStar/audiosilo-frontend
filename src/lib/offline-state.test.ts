import { offlineState } from './offline-state';

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
