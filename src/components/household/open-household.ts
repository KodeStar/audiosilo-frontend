import { pushInShell } from '@/lib/open';
import { householdHref } from '@/lib/paths';
import { currentNavState, focusedRoute } from '@/lib/root-stack';

/**
 * The Household page (`/household`): a page pushed on the current tab like Settings, so
 * back returns where the listener was (from "Who's listening?" or the full player it
 * lands in the shell underneath, `pushInShell`). On the page already, nothing happens.
 * Every way in goes through here: the profile menu, "Who's listening?" > Manage household,
 * Settings, Home's house row.
 *
 * Takes no argument, so it can be an `onPress` as it is: a press hands its event to the
 * handler, which a navigation-state parameter once read as the state and threw on.
 */
export function openHousehold() {
  const state = currentNavState();
  if (focusedRoute(state)?.name === 'household') return;
  pushInShell(householdHref(), state);
}
