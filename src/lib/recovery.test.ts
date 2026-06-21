import type { User } from '@/api/types';

import { accountFlagsKnown, needsRecoveryWarning } from './recovery';

const base: User = {
  id: 1,
  username: 'u',
  role: 'user',
  disabled: false,
  has_password: false,
  has_recovery: false,
};

describe('needsRecoveryWarning', () => {
  it('warns when a non-admin has neither a password nor a recovery code', () => {
    expect(needsRecoveryWarning(base)).toBe(true);
  });

  it('does not warn when the user has a password', () => {
    expect(needsRecoveryWarning({ ...base, has_password: true })).toBe(false);
  });

  it('does not warn when the user has a recovery code', () => {
    expect(needsRecoveryWarning({ ...base, has_recovery: true })).toBe(false);
  });

  it('never warns an admin (they always keep a password)', () => {
    expect(needsRecoveryWarning({ ...base, role: 'admin' })).toBe(false);
  });

  it('does not warn when the flags are unknown (a session stored before they existed)', () => {
    const stale = { id: 2, username: 's', role: 'user', disabled: false } as unknown as User;
    expect(needsRecoveryWarning(stale)).toBe(false);
  });

  it('does not warn for a signed-out (null/undefined) user', () => {
    expect(needsRecoveryWarning(null)).toBe(false);
    expect(needsRecoveryWarning(undefined)).toBe(false);
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
