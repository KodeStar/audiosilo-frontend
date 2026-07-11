import type { User } from '@/api/types';

import { accountFlagsKnown, needsPasswordWarning } from './account';

const base: User = {
  id: 1,
  username: 'u',
  role: 'user',
  disabled: false,
  has_password: false,
  has_recovery: false,
};

describe('needsPasswordWarning', () => {
  it('warns when a non-admin has no password', () => {
    expect(needsPasswordWarning(base)).toBe(true);
  });

  it('does not warn when the user has a password', () => {
    expect(needsPasswordWarning({ ...base, has_password: true })).toBe(false);
  });

  it('does not warn when the user has a recovery code (a legacy but working way back in)', () => {
    expect(needsPasswordWarning({ ...base, has_password: false, has_recovery: true })).toBe(false);
  });

  it('warns when a non-admin has neither a password nor a recovery code', () => {
    expect(needsPasswordWarning({ ...base, has_password: false, has_recovery: false })).toBe(true);
  });

  it('does not warn when has_recovery is unknown (needs positive knowledge of both flags)', () => {
    const legacy = {
      id: 3,
      username: 'l',
      role: 'user',
      disabled: false,
      has_password: false,
    } as unknown as User;
    expect(needsPasswordWarning(legacy)).toBe(false);
  });

  it('never warns an admin (they always keep a password)', () => {
    expect(needsPasswordWarning({ ...base, role: 'admin' })).toBe(false);
  });

  it('never warns a demo account (the server refuses it a password)', () => {
    expect(needsPasswordWarning({ ...base, is_demo: true })).toBe(false);
  });

  it('does not warn when the flags are unknown (a session stored before they existed)', () => {
    const stale = { id: 2, username: 's', role: 'user', disabled: false } as unknown as User;
    expect(needsPasswordWarning(stale)).toBe(false);
  });

  it('does not warn for a signed-out (null/undefined) user', () => {
    expect(needsPasswordWarning(null)).toBe(false);
    expect(needsPasswordWarning(undefined)).toBe(false);
  });
});

describe('accountFlagsKnown', () => {
  it('is true once the flags are present (any value)', () => {
    expect(accountFlagsKnown(base)).toBe(true);
    expect(accountFlagsKnown({ ...base, has_password: true })).toBe(true);
  });

  it('is false for a session stored before the flags existed', () => {
    const stale = { id: 2, username: 's', role: 'user', disabled: false } as unknown as User;
    expect(accountFlagsKnown(stale)).toBe(false);
  });

  it('is false for a signed-out (null/undefined) user', () => {
    expect(accountFlagsKnown(null)).toBe(false);
    expect(accountFlagsKnown(undefined)).toBe(false);
  });
});
