import {
  beginInviteSignIn,
  dropConnectHandoffs,
  holdInvite,
  holdReconnect,
  holdScanReconnect,
  openScanner,
  peekInviteCode,
  peekReconnect,
  peekScanFor,
  peekScanReconnect,
  takeInviteCode,
  takeReconnect,
  takeScanFor,
  takeScanReconnect,
} from './invite-handoff';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ router: { push: (h: unknown) => mockPush(h) } }));
const mockSetPending = jest.fn((_url: string) => Promise.resolve());
jest.mock('@/stores/session', () => ({
  useSession: { getState: () => ({ setPendingServerUrl: mockSetPending }) },
}));

it('opens one sign-in step for an invite already on its way, in any spelling of its code', async () => {
  dropConnectHandoffs();
  const go = jest.fn();
  beginInviteSignIn({ base: 'https://a.example', code: 'ABCD-1234' }, go);
  beginInviteSignIn({ base: 'https://a.example', code: 'abcd 1234' }, go);
  await Promise.resolve();
  await Promise.resolve();
  expect(mockSetPending).toHaveBeenCalledTimes(1);
  expect(go).toHaveBeenCalledTimes(1);
  expect(takeInviteCode('https://a.example')).toBe('ABCD-1234');
});

it("hands a held invite's code to its own server's sign-in, once", () => {
  holdInvite({ base: 'https://a.example', code: 'ABCD-1234' });
  expect(takeInviteCode('https://a.example')).toBe('ABCD-1234');
  expect(takeInviteCode('https://a.example')).toBeUndefined();
});

it("never hands it to another server's sign-in, and drops it there", () => {
  holdInvite({ base: 'https://a.example', code: 'ABCD-1234' });
  expect(takeInviteCode('https://b.example')).toBeUndefined();
  expect(takeInviteCode('https://a.example')).toBeUndefined();
});

it('opens the scanner with its reconnect in memory, taken once, never in the route', () => {
  openScanner('srv.1');
  expect(mockPush).toHaveBeenLastCalledWith('/connect/scan');
  expect(takeScanFor()).toBe('srv.1');
  expect(takeScanFor()).toBeUndefined();
  // Opened again without one: what an earlier opener left is not kept.
  openScanner('srv.1');
  openScanner();
  expect(takeScanFor()).toBeUndefined();
});

// fe#299: the book the sign-in step was heading to goes with the scanner, as a link's does.
it('opens the scanner with the book its sign-in step was heading to', () => {
  openScanner(undefined, { libraryId: 2, path: 'A/Book' });
  expect(mockPush).toHaveBeenLastCalledWith({
    pathname: '/connect/scan',
    params: { book: '2', path: 'A/Book' },
  });
});

it('hands a reconnect to the sign-in step for its own server only, once (fe#298)', () => {
  holdReconnect('https://a.example/', 'srv.1');
  expect(takeReconnect('https://a.example')).toBe('srv.1');
  expect(takeReconnect('https://a.example')).toBeUndefined();
  // Another server's sign-in step takes none, and drops it.
  holdReconnect('https://a.example', 'srv.1');
  expect(takeReconnect('https://b.example')).toBeUndefined();
  expect(takeReconnect('https://a.example')).toBeUndefined();
  // A sign-in step with no server (it goes back to the first step) drops it too.
  holdReconnect('https://a.example', 'srv.1');
  expect(takeReconnect(null)).toBeUndefined();
  expect(takeReconnect('https://a.example')).toBeUndefined();
});

it('drops what no scanner or connect step took when the flow is left', () => {
  openScanner('srv.1');
  holdScanReconnect('tok', 'srv.1');
  holdReconnect('https://a.example', 'srv.1');
  holdInvite({ base: 'https://a.example', code: 'ABCD-1234' });
  dropConnectHandoffs();
  expect(takeInviteCode('https://a.example')).toBeUndefined();
  expect(takeScanFor()).toBeUndefined();
  expect(takeScanReconnect('tok')).toBeUndefined();
  expect(takeReconnect('https://a.example')).toBeUndefined();
});

// A screen reads what it was handed as it renders and takes it once it shows: a read leaves
// it held, for a render that is run again.
it('leaves a handoff held when it is only read', () => {
  holdInvite({ base: 'https://a.example', code: 'ABCD-1234' });
  holdReconnect('https://a.example', 'srv.1');
  openScanner('srv.2');
  holdScanReconnect('tok', 'srv.3');
  expect(peekInviteCode('https://b.example')).toBeUndefined();
  expect(peekInviteCode('https://a.example')).toBe('ABCD-1234');
  expect(peekInviteCode('https://a.example')).toBe('ABCD-1234');
  expect(peekReconnect('https://a.example')).toBe('srv.1');
  expect(peekReconnect(null)).toBeUndefined();
  expect(peekScanFor()).toBe('srv.2');
  expect(peekScanReconnect('tok')).toBe('srv.3');
  expect(takeInviteCode('https://a.example')).toBe('ABCD-1234');
  expect(takeReconnect('https://a.example')).toBe('srv.1');
  expect(takeScanFor()).toBe('srv.2');
  expect(takeScanReconnect('tok')).toBe('srv.3');
});
