import type { User } from '@/api/types';

/**
 * Whether to warn the user before they sign out. A password-less account with no
 * recovery code has no self-service way back in - signing out revokes their only
 * credential and strands them until an admin mints a fresh invite.
 *
 * Admins always keep a password (a server invariant), so they can always sign back
 * in - never warn them. Demo accounts are throwaway and the server refuses them a
 * password or recovery code, so the warning's only forward action (mint a recovery
 * code) would 403 - never warn them either. For everyone else, warn only when we
 * positively know the account has neither a password nor a recovery code; an unknown
 * flag is treated as "don't warn" rather than a guess that would false-positive. The
 * caller (`useSignOut`) refreshes the flags from /me before deciding when they're
 * unknown, so this only stays unknown when the server is unreachable - and offline a
 * warning would be a dead end anyway (a recovery code can't be minted without the server).
 */
export function needsRecoveryWarning(user: User | null | undefined): boolean {
  if (!user || user.role === 'admin' || user.is_demo) return false;
  return user.has_password === false && user.has_recovery === false;
}

/**
 * Whether the account flags that drive {@link needsRecoveryWarning} have been
 * loaded. A session persisted before `has_password`/`has_recovery` existed carries
 * them as `undefined` at runtime even though the type says `boolean`; callers use
 * this to refresh from /me before relying on the warning.
 */
export function accountFlagsKnown(user: User | null | undefined): boolean {
  return !!user && (user as { has_password?: boolean }).has_password !== undefined;
}
