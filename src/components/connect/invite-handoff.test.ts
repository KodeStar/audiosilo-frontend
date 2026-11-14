import {
  dropScanHandoffs,
  holdInvite,
  holdScanReconnect,
  openScanner,
  takeInviteCode,
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

it('drops what no scanner or connect step took when the flow is left', () => {
  openScanner('srv.1');
  holdScanReconnect('tok', 'srv.1');
  dropScanHandoffs();
  expect(takeScanFor()).toBeUndefined();
  expect(takeScanReconnect('tok')).toBeUndefined();
});
