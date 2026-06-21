import type { User } from '@/api/types';

/**
 * Whether to warn the user before they sign out. A password-less account with no
 * recovery code has no self-service way back in — signing out revokes their only
 * credential and strands them until an admin mints a fresh invite.
 *
 * Admins always keep a password (a server invariant), so they can always sign back
 * in — never warn them. For everyone else, warn only when we positively know the
 * account has neither a password nor a recovery code: an unknown flag (e.g. a
 * session persisted before these fields existed, before /me refreshes it) is
 * treated as "don't warn" rather than a guess that would false-positive.
 */
export function needsRecoveryWarning(user: User | null | undefined): boolean {
  if (!user || user.role === 'admin') return false;
  return user.has_password === false && user.has_recovery === false;
}
