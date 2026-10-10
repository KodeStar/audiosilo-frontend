import type { TFunction } from 'i18next';

import { formatTimeOfDay } from '@/lib/format';
import { connectionsOfProfile, type Profile, type ProfilesDoc } from '@/stores/profiles';
import type { Connection } from '@/stores/session';

/**
 * The rules of the profile screens ("Who's listening?", the profile menu, Settings >
 * Household), pure so they're tested apart from them.
 */

/** A profile's name for the screen: its own (the store fills an empty one from its first
 * server's username, `reconcileProfiles`), else a neutral word (no username known yet). */
export function profileName(profile: Profile, t: TFunction): string {
  return profile.name.trim() || t('profiles.someone');
}

/** The servers a profile listens on, as one line: "Hearthside", "Hearthside + 1 more". */
export function serversLine(
  profile: Profile,
  connections: readonly Connection[],
  t: TFunction,
): string {
  const own = connectionsOfProfile(connections, profile.connectionIds);
  if (own.length === 0) return '';
  if (own.length === 1) return own[0].name;
  return t('profiles.status.servers', { name: own[0].name, count: own.length - 1 });
}

/** The one-line status under a person on "Who's listening?" (the prototype's): kids mode
 * and its bedtime, else "Listening now" for the active person, else their servers. */
export function profileStatus(
  profile: Profile,
  connections: readonly Connection[],
  active: boolean,
  t: TFunction,
): string {
  // On the reader's clock, like every other bedtime on screen (`formatTimeOfDay`).
  if (profile.kids)
    return t('profiles.status.kids', { time: formatTimeOfDay(profile.kids.bedtime) });
  if (active) return t('profiles.status.listening');
  return serversLine(profile, connections, t);
}

/** Whether "Who's listening?" opens when the app does: two or more people and the
 * setting on. */
export function asksAtLaunch(doc: Pick<ProfilesDoc, 'profiles' | 'askAtLaunch'>): boolean {
  return doc.askAtLaunch && doc.profiles.length >= 2;
}

/** How a PIN wait reads: whole seconds, rounded up (never "0 s" while still waiting). */
export function waitSeconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}

/** Whether this launch has decided about "Who's listening?" yet (once per JS runtime: a
 * cold start). */
let launchDecided = false;

/** True the first time it is asked in this runtime, then false: the auth gate decides
 * once whether a cold launch shows "Who's listening?". */
export function takeLaunchDecision(): boolean {
  if (launchDecided) return false;
  launchDecided = true;
  return true;
}

/** Tests only. */
export function resetLaunchDecisionForTests(): void {
  launchDecided = false;
}
