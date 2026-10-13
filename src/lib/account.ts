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

/** The name a new person on this device is given for `user`: a household member's name
 * as their owner gave it (`display_name`, Phase 8b-1), else the username. Read
 * defensively: a stored connection's user may come from an older build. */
export function personName(
  user: Partial<Pick<User, 'username' | 'display_name'>> | null | undefined,
): string {
  const display = typeof user?.display_name === 'string' ? user.display_name.trim() : '';
  if (display) return display;
  return typeof user?.username === 'string' ? user.username : '';
}

/** Who manages `user`'s account when it is a household member (`managed_by`, Phase 8b-1),
 * by username; null for an ordinary account and on older servers. */
export function managerName(user: Pick<User, 'managed_by'> | null | undefined): string | null {
  return user?.managed_by?.username || null;
}

/** Whether `user` is a kid's account (a household member the server says is a kid,
 * `member_kind`, Phase 8b-1): no password or API keys, their owner signs them in. */
export function isKidAccount(user: Pick<User, 'member_kind'> | null | undefined): boolean {
  return user?.member_kind === 'kid';
}
