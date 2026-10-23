import { holdInvite, takeInviteCode } from './invite-handoff';

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
