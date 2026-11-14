import { act, render, screen } from '@testing-library/react-native';

import { useSession } from '@/stores/session';

// The QR scanner route (`src/app/connect/scan.tsx`): which codes it takes, and where each
// goes. The test lives here because a file under `src/app` is a route to Expo Router.

const mockReplace = jest.fn();
let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  router: { replace: (h: unknown) => mockReplace(h), back: jest.fn() },
  useLocalSearchParams: () => mockParams,
}));
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
// The camera, with its permission granted: the test plays the scanned code.
let mockOnScan: ((r: { data: string }) => void) | null = null;
jest.mock('expo-camera', () => ({
  useCameraPermissions: () => [{ status: 'granted', granted: true }, jest.fn()],
  CameraView: ({ onBarcodeScanned }: { onBarcodeScanned: (r: { data: string }) => void }) => {
    mockOnScan = onBarcodeScanned;
    return null;
  },
}));

/* eslint-disable import/first */
import ScanScreen from '@/app/connect/scan';
import { takeInviteCode, takeScanReconnect } from '@/components/connect/invite-handoff';
/* eslint-enable import/first */

const scan = (data: string) => act(async () => mockOnScan?.({ data }));

beforeEach(() => {
  mockReplace.mockReset();
  mockOnScan = null;
  mockParams = {};
  useSession.setState({ pendingServerUrl: null, connections: [] });
});

it("goes to the invite sign-in with an invite QR's server and code (#98)", async () => {
  await render(<ScanScreen />);
  await scan('https://books.example.com:8443/connect#code=ABCD-EFGH-JKMN-PQRS');
  expect(useSession.getState().pendingServerUrl).toBe('https://books.example.com:8443');
  expect(mockReplace).toHaveBeenCalledWith('/connect/sign-in');
  expect(takeInviteCode('https://books.example.com:8443')).toBe('ABCD-EFGH-JKMN-PQRS');
});

it('hands a pairing QR to the connect screen as before', async () => {
  await render(<ScanScreen />);
  await scan('https://books.example.com/web/connect?token=abc');
  expect(mockReplace).toHaveBeenCalledWith({
    pathname: '/connect',
    params: expect.objectContaining({ server: 'https://books.example.com', token: 'abc' }),
  });
});

it('says a code is neither a pairing nor an invite code, then lets the camera aim again', async () => {
  jest.useFakeTimers();
  try {
    await render(<ScanScreen />);
    await scan('https://books.example.com/connect#code=<nope>');
    expect(
      screen.getByText("That QR code isn't an AudioSilo pairing or invite code."),
    ).toBeTruthy();
    expect(mockReplace).not.toHaveBeenCalled();
    expect(useSession.getState().pendingServerUrl).toBeNull();
    await act(async () => jest.advanceTimersByTime(1500));
    await scan('https://books.example.com/connect#code=ABCD-1234');
    expect(mockReplace).toHaveBeenCalledWith('/connect/sign-in');
  } finally {
    jest.useRealTimers();
  }
});

it('says where the QR is: the console for an admin, the invite page for anyone invited', async () => {
  await render(<ScanScreen />);
  expect(screen.getByText(/People > your name > Pair a device/)).toBeTruthy();
  expect(screen.getByText(/on your invite page/)).toBeTruthy();
});

describe("opened from a reconnect's sign-in step (`reconnect`)", () => {
  // The connection being signed in again: paired at home, with an away address too.
  const reconnecting = () =>
    useSession.setState({
      connections: [
        {
          id: 'srv-1.1',
          serverId: 'srv-1',
          name: 'Hearthside',
          serverUrl: 'http://192.168.1.20:8080',
          addresses: { home: 'http://192.168.1.20:8080', away: 'https://books.example.com' },
          token: 't',
        } as never,
      ],
    });

  it("keeps the reconnect for a pairing QR of that connection's server, never in the route", async () => {
    reconnecting();
    mockParams = { reconnect: 'srv-1.1' };
    await render(<ScanScreen />);
    await scan('https://books.example.com/web/connect?token=abc');
    expect(mockReplace).toHaveBeenCalledWith({
      pathname: '/connect',
      params: { server: 'https://books.example.com', token: 'abc' },
    });
    // That code's only: another token takes nothing.
    expect(takeScanReconnect('other')).toBeUndefined();
  });

  it('hands it to the connect screen with the code (taken by its token)', async () => {
    reconnecting();
    mockParams = { reconnect: 'srv-1.1' };
    await render(<ScanScreen />);
    await scan('https://books.example.com/web/connect?token=abc');
    expect(takeScanReconnect('abc')).toBe('srv-1.1');
    expect(takeScanReconnect('abc')).toBeUndefined();
  });

  it("keeps it for an invite QR of that server: the sign-in step's own `reconnect`", async () => {
    reconnecting();
    mockParams = { reconnect: 'srv-1.1' };
    await render(<ScanScreen />);
    await scan('https://books.example.com/connect#code=ABCD-EFGH-JKMN-PQRS');
    expect(mockReplace).toHaveBeenCalledWith({
      pathname: '/connect/sign-in',
      params: { reconnect: 'srv-1.1' },
    });
  });

  it('drops it for a code of any other server, or a connection that is gone: a new connection', async () => {
    reconnecting();
    mockParams = { reconnect: 'srv-1.1' };
    const first = await render(<ScanScreen />);
    await scan('https://other.example.com/web/connect?token=abc');
    expect(takeScanReconnect('abc')).toBeUndefined();
    await first.unmount();
    await render(<ScanScreen />);
    await scan('https://other.example.com/connect#code=ABCD-EFGH-JKMN-PQRS');
    expect(mockReplace).toHaveBeenLastCalledWith('/connect/sign-in');
    mockParams = { reconnect: 'gone.9' };
    await render(<ScanScreen />);
    await scan('https://books.example.com/web/connect?token=def');
    expect(takeScanReconnect('def')).toBeUndefined();
  });
});
