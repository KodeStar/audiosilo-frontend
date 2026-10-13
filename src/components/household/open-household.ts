import { pushInShell } from '@/lib/open';
import { householdHref } from '@/lib/paths';
import { currentNavState, focusedRoute, type NavState } from '@/lib/root-stack';

/**
 * The Household page (`/household`): a page pushed on the current tab like Settings, so
 * back returns where the listener was (from "Who's listening?" or the full player it
 * lands in the shell underneath, `pushInShell`). On the page already, nothing happens.
 * Every way in goes through here: the profile menu, "Who's listening?" > Manage household,
 * Settings, Home's house row.
 */
export function openHousehold(state: NavState | undefined = currentNavState()) {
  if (focusedRoute(state)?.name === 'household') return;
  pushInShell(householdHref(), state);
}
