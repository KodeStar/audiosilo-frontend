import { act, render, screen } from '@testing-library/react-native';

import { useSession } from '@/stores/session';

// The QR scanner route (`src/app/connect/scan.tsx`): which codes it takes, and where each
// goes. The test lives here because a file under `src/app` is a route to Expo Router.

const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  router: { replace: (h: unknown) => mockReplace(h), back: jest.fn() },
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
import { takeInviteCode } from '@/components/connect/invite-handoff';
/* eslint-enable import/first */

const scan = (data: string) => act(async () => mockOnScan?.({ data }));

beforeEach(() => {
  mockReplace.mockReset();
  mockOnScan = null;
  useSession.setState({ pendingServerUrl: null });
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
