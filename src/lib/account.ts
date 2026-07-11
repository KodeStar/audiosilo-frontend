import type { User } from '@/api/types';

/**
 * Whether to warn the user before they sign out. A password-less account has no
 * self-service way back in - signing out revokes its only credential (the session
 * token) and strands the user until an admin mints a fresh invite. Setting a
 * password first gives them a durable way to sign back in on any device.
 *
 * Admins always keep a password (a server invariant), so they can always sign back
 * in - never warn them. Demo accounts are throwaway and the server refuses them a
 * password, so the warning's forward action (set a password) would 403 - never warn
 * them either. A legacy user who still holds a WORKING recovery code
 * (`has_recovery === true`) also has a durable way back in - the connect screen's
 * code field re-pairs through the same `redeemCode -> exchange` path the server
 * still honors - so warning them "you'll need a new invite" would be false; exempt
 * them too. For everyone else, warn only when we positively know the account has
 * neither a password nor a recovery code; an unknown flag is treated as "don't
 * warn" rather than a guess that would false-positive. That means an unknown
 * `has_recovery` (a session persisted before the flag existed) fails the strict
 * `has_recovery === false` test and does NOT warn, mirroring the old
 * `recovery.ts needsRecoveryWarning` semantics exactly (warn requires positive
 * knowledge of both flags). The caller (`useSignOut`) refreshes the flags from /me
 * before deciding when they're unknown, so this only stays unknown when the server
 * is unreachable - and offline a warning would be a dead end anyway (a password
 * can't be set without the server).
 */
export function needsPasswordWarning(user: User | null | undefined): boolean {
  if (!user || user.role === 'admin' || user.is_demo) return false;
  return user.has_password === false && user.has_recovery === false;
}

/**
 * Whether the account flags that drive {@link needsPasswordWarning} have been
 * loaded. A session persisted before `has_password` existed carries it as
 * `undefined` at runtime even though the type says `boolean`; callers use this to
 * refresh from /me before relying on the warning.
 */
export function accountFlagsKnown(user: User | null | undefined): boolean {
  return !!user && (user as { has_password?: boolean }).has_password !== undefined;
}
