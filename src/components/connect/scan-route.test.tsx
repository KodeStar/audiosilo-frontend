import { act, render, screen } from '@testing-library/react-native';

import { useSession } from '@/stores/session';

// The QR scanner route (`src/app/connect/scan.tsx`): which codes it takes, and where each
// goes. The test lives here because a file under `src/app` is a route to Expo Router.

const mockReplace = jest.fn();
let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  router: { replace: (h: unknown) => mockReplace(h), back: jest.fn(), push: jest.fn() },
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
import {
  dropConnectHandoffs,
  openScanner,
  takeInviteCode,
  takeReconnect,
  takeScanReconnect,
} from '@/components/connect/invite-handoff';
/* eslint-enable import/first */

const scan = (data: string) => act(async () => mockOnScan?.({ data }));

beforeEach(() => {
  mockReplace.mockReset();
  mockOnScan = null;
  mockParams = {};
  dropConnectHandoffs();
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

// fe#299: opened from a sign-in step that was heading to a book, the scan still ends on it.
describe('opened with the book its sign-in step was heading to', () => {
  beforeEach(() => {
    mockParams = { book: '2', path: 'A/Book' };
    useSession.setState({ pendingServerUrl: 'https://books.example.com' });
  });

  it("takes it to an invite's sign-in step", async () => {
    await render(<ScanScreen />);
    await scan('https://books.example.com/connect#code=ABCD-EFGH-JKMN-PQRS');
    expect(mockReplace).toHaveBeenCalledWith({
      pathname: '/connect/sign-in',
      params: { book: '2', path: 'A/Book' },
    });
  });

  it("takes it to a pairing code's exchange, unless the code names its own", async () => {
    await render(<ScanScreen />);
    await scan('https://books.example.com/web/connect?token=abc');
    expect(mockReplace).toHaveBeenLastCalledWith({
      pathname: '/connect',
      params: expect.objectContaining({ token: 'abc', book: '2', path: 'A/Book' }),
    });
    await render(<ScanScreen />);
    await scan('https://books.example.com/web/connect?token=def&book=7&path=B%2FOther');
    expect(mockReplace).toHaveBeenLastCalledWith({
      pathname: '/connect',
      params: expect.objectContaining({ token: 'def', book: '7', path: 'B/Other' }),
    });
  });

  // A home and away install: the step was reached at home, the console's code names the
  // away address and gives the home one beside it.
  it("goes on with a code that gives the step's address as another of its server's", async () => {
    useSession.setState({ pendingServerUrl: 'http://192.168.1.20:8080' });
    await render(<ScanScreen />);
    await scan(
      'https://books.example.com/web/connect?token=abc&home=http%3A%2F%2F192.168.1.20%3A8080',
    );
    expect(mockReplace).toHaveBeenCalledWith({
      pathname: '/connect',
      params: expect.objectContaining({ token: 'abc', book: '2', path: 'A/Book' }),
    });
  });

  // Another server's library ids name other books: a code for it ends on its Home.
  it("leaves it behind with another server's code", async () => {
    await render(<ScanScreen />);
    await scan('https://other.example.com/connect#code=ABCD-EFGH-JKMN-PQRS');
    expect(mockReplace).toHaveBeenLastCalledWith('/connect/sign-in');
    // The invite's sign-in moved the address on: back to the step's own.
    useSession.setState({ pendingServerUrl: 'https://books.example.com' });
    await render(<ScanScreen />);
    await scan('https://other.example.com/web/connect?token=abc');
    expect(mockReplace).toHaveBeenLastCalledWith({
      pathname: '/connect',
      params: expect.not.objectContaining({ book: '2' }),
    });
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

describe("opened from a reconnect's sign-in step (`openScanner`)", () => {
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
    openScanner('srv-1.1');
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
    openScanner('srv-1.1');
    await render(<ScanScreen />);
    await scan('https://books.example.com/web/connect?token=abc');
    expect(takeScanReconnect('abc')).toBe('srv-1.1');
    expect(takeScanReconnect('abc')).toBeUndefined();
  });

  it('keeps it for an invite QR of that server, in memory for the sign-in step (fe#298)', async () => {
    reconnecting();
    openScanner('srv-1.1');
    await render(<ScanScreen />);
    await scan('https://books.example.com/connect#code=ABCD-EFGH-JKMN-PQRS');
    expect(mockReplace).toHaveBeenCalledWith('/connect/sign-in');
    expect(takeReconnect('https://books.example.com')).toBe('srv-1.1');
  });

  // fe#299: the step was at the address the connection uses at home, the code names its
  // away address. The reconnect it continues says it is the step's server.
  it('keeps the book the step was heading to with a code that continues the reconnect', async () => {
    reconnecting();
    useSession.setState({ pendingServerUrl: 'http://192.168.1.20:8080' });
    mockParams = { book: '2', path: 'A/Book' };
    openScanner('srv-1.1');
    const first = await render(<ScanScreen />);
    await scan('https://books.example.com/web/connect?token=abc');
    expect(mockReplace).toHaveBeenCalledWith({
      pathname: '/connect',
      params: expect.objectContaining({ token: 'abc', book: '2', path: 'A/Book' }),
    });
    expect(takeScanReconnect('abc')).toBe('srv-1.1');
    await first.unmount();
    openScanner('srv-1.1');
    await render(<ScanScreen />);
    await scan('https://books.example.com/connect#code=ABCD-EFGH-JKMN-PQRS');
    expect(mockReplace).toHaveBeenLastCalledWith({
      pathname: '/connect/sign-in',
      params: { book: '2', path: 'A/Book' },
    });
  });

  it('drops it for a code of any other server, or a connection that is gone: a new connection', async () => {
    reconnecting();
    openScanner('srv-1.1');
    const first = await render(<ScanScreen />);
    await scan('https://other.example.com/web/connect?token=abc');
    expect(takeScanReconnect('abc')).toBeUndefined();
    await first.unmount();
    openScanner('srv-1.1');
    await render(<ScanScreen />);
    await scan('https://other.example.com/connect#code=ABCD-EFGH-JKMN-PQRS');
    expect(mockReplace).toHaveBeenLastCalledWith('/connect/sign-in');
    openScanner('gone.9');
    await render(<ScanScreen />);
    await scan('https://books.example.com/web/connect?token=def');
    expect(takeScanReconnect('def')).toBeUndefined();
  });

  it('takes it once, and never from the route: a link that opens the scanner names none', async () => {
    reconnecting();
    // A link (`audiosilo://connect/scan?reconnect=`): its param is not read.
    mockParams = { reconnect: 'srv-1.1' };
    const linked = await render(<ScanScreen />);
    await scan('https://books.example.com/web/connect?token=abc');
    expect(takeScanReconnect('abc')).toBeUndefined();
    await linked.unmount();
    // Opened for a reconnect, then opened again without one: the first is not kept.
    openScanner('srv-1.1');
    const first = await render(<ScanScreen />);
    await first.unmount();
    await render(<ScanScreen />);
    await scan('https://books.example.com/web/connect?token=def');
    expect(takeScanReconnect('def')).toBeUndefined();
  });
});
