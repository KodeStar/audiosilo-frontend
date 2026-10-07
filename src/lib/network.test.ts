import { Platform } from 'react-native';
import * as Network from 'expo-network';

import { canAutoDownload, onNetworkChange } from './network';

// The real module needs a native ExpoNetwork; stub it and drive each branch.
jest.mock('expo-network', () => ({
  __esModule: true,
  NetworkStateType: {
    NONE: 'NONE',
    UNKNOWN: 'UNKNOWN',
    CELLULAR: 'CELLULAR',
    WIFI: 'WIFI',
    ETHERNET: 'ETHERNET',
  },
  getNetworkStateAsync: jest.fn(),
}));

const mockGetState = Network.getNetworkStateAsync as jest.Mock;

describe('canAutoDownload', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Platform.OS = 'ios';
  });

  it("'never' is always false and never probes", async () => {
    await expect(canAutoDownload('never')).resolves.toBe(false);
    expect(mockGetState).not.toHaveBeenCalled();
  });

  it("'always' is always true and never probes", async () => {
    await expect(canAutoDownload('always')).resolves.toBe(true);
    expect(mockGetState).not.toHaveBeenCalled();
  });

  it("'wifi' allows Wi-Fi and Ethernet", async () => {
    mockGetState.mockResolvedValueOnce({ type: Network.NetworkStateType.WIFI });
    await expect(canAutoDownload('wifi')).resolves.toBe(true);
    mockGetState.mockResolvedValueOnce({ type: Network.NetworkStateType.ETHERNET });
    await expect(canAutoDownload('wifi')).resolves.toBe(true);
  });

  it("'wifi' denies cellular", async () => {
    mockGetState.mockResolvedValueOnce({ type: Network.NetworkStateType.CELLULAR });
    await expect(canAutoDownload('wifi')).resolves.toBe(false);
  });

  it("'wifi' denies when there is no connection", async () => {
    mockGetState.mockResolvedValueOnce({ type: Network.NetworkStateType.NONE });
    await expect(canAutoDownload('wifi')).resolves.toBe(false);
  });

  it("'wifi' allows an UNKNOWN or missing type (can't tell; assume unmetered)", async () => {
    mockGetState.mockResolvedValueOnce({ type: Network.NetworkStateType.UNKNOWN });
    await expect(canAutoDownload('wifi')).resolves.toBe(true);
    mockGetState.mockResolvedValueOnce({});
    await expect(canAutoDownload('wifi')).resolves.toBe(true);
  });

  it("'wifi' fails open when the probe throws", async () => {
    mockGetState.mockRejectedValueOnce(new Error('no native module'));
    await expect(canAutoDownload('wifi')).resolves.toBe(true);
  });

  it("'wifi' allows on web without probing", async () => {
    Platform.OS = 'web';
    await expect(canAutoDownload('wifi')).resolves.toBe(true);
    expect(mockGetState).not.toHaveBeenCalled();
  });
});

describe('onNetworkChange', () => {
  it('subscribes to the native network events and unsubscribes', () => {
    const remove = jest.fn();
    const add = jest.fn(() => ({ remove }));
    (Network as unknown as { addNetworkStateListener: unknown }).addNetworkStateListener = add;
    Platform.OS = 'ios';
    const listener = jest.fn();
    const off = onNetworkChange(listener);
    (add.mock.calls[0] as unknown as [() => void])[0]();
    expect(listener).toHaveBeenCalled();
    off();
    expect(remove).toHaveBeenCalled();
  });

  it('subscribes to nothing on the web', () => {
    Platform.OS = 'web';
    expect(() => onNetworkChange(jest.fn())()).not.toThrow();
  });
});
