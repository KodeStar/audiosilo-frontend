import {
  dropConnectHandoffs,
  holdInvite,
  holdReconnect,
  holdScanReconnect,
  openScanner,
  takeInviteCode,
  takeReconnect,
  takeScanFor,
  takeScanReconnect,
} from './invite-handoff';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ router: { push: (h: unknown) => mockPush(h) } }));

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
  dropConnectHandoffs();
  expect(takeScanFor()).toBeUndefined();
  expect(takeScanReconnect('tok')).toBeUndefined();
  expect(takeReconnect('https://a.example')).toBeUndefined();
});
