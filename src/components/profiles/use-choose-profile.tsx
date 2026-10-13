import { router } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { TABS } from '@/components/shell/destinations';
import { toast } from '@/components/ui/toast';
import { readPinMirrored, type StoredPin } from '@/lib/profile-pin';
import { popTabToRoot } from '@/lib/root-stack';
import { type Profile, switchProfile, useProfiles } from '@/stores/profiles';

import { PinDialog } from './pin-dialog';
import { profileName } from './profiles-model';

/** The way into "Who's listening?" (a root route over the app). */
const PROFILES_HREF = '/profiles';

/** Whether the picker on screen was opened from inside the app (`openProfiles`), with a
 * page of the app under it to go back to. Else it was loaded cold (a reload while it was
 * open, a typed URL): the root stack still has the `(app)` anchor under it, so "back"
 * would land on whatever the anchor starts with, not where anyone was. */
let openedInApp = false;

/** Open "Who's listening?" over the app: every way in from the app goes through here. */
export function openProfiles(): void {
  openedInApp = true;
  router.push(PROFILES_HREF);
}

/** The picker left the screen (tests too): the next one is cold until opened again. */
export function forgetPickerOpener(): void {
  openedInApp = false;
}

/** Back to the app after another person was chosen: every tab back at its root (a page of
 * the previous person's, a book on their server, must not stay under the new person's
 * tabs), then Home. A kids profile is taken on from there by the auth gate. */
function homeForNewPerson(): void {
  openedInApp = false;
  for (const tab of TABS) popTabToRoot(tab.name);
  router.dismissTo('/');
}

/** Leave "Who's listening?" as the same person: back where they were when the app opened
 * it (at a cold launch, the page a link opened), else Home (a cold load of the picker
 * itself), in one press either way. */
export function leavePicker(): void {
  const back = openedInApp && router.canGoBack();
  openedInApp = false;
  if (back) router.back();
  else router.dismissTo('/');
}

/**
 * Choosing a person: the active one just goes back (while someone must be chosen,
 * `mustChoose`, nobody is active); a profile with a PIN asks for it
 * first (`PinDialog`). Whether there is one is the secure store's answer, read for every
 * choice: a hash the mirror lost still asks (and repairs the mirror), and a mirror whose
 * hash the secure store doesn't have any more counts as no PIN. A store that can't be read
 * never switches, whatever the mirror says: it says it couldn't check, and the listener
 * tries again. Then `switchProfile` and Home (`homeForNewPerson`). `stay`: switch where the
 * listener is (a link to another person's book that switches first) instead of going Home.
 * Render `dialog` somewhere in the screen (it portals).
 */
export function useChooseProfile({ stay = false }: { stay?: boolean } = {}) {
  const { t } = useTranslation();
  /** The person whose PIN is asked, with the PIN as `choose` read it (the prompt checks
   * against it instead of reading the secure store again). */
  const [pinFor, setPinFor] = useState<{ profile: Profile; stored: StoredPin } | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);

  const finish = async (profile: Profile) => {
    setSwitching(profile.id);
    try {
      await switchProfile(profile.id);
    } finally {
      setSwitching(null);
    }
    if (!stay) homeForNewPerson();
  };

  const choose = async (profile: Profile) => {
    if (switching) return;
    // The person already listening goes back. Nobody is while someone must be chosen
    // (`mustChoose`): then everyone is chosen like anyone, PIN and all.
    if (profile.id === useProfiles.getState().activeProfileId) {
      if (!stay) leavePicker();
      return;
    }
    // The secure store says whether there is a PIN, never the profile's mirror alone
    // (`readPinMirrored` repairs the mirror).
    let stored: StoredPin | null;
    try {
      stored = await readPinMirrored(profile);
    } catch {
      // Unreadable: never switch on the mirror's word (a lost mirror would let anyone in).
      toast({ title: t('profiles.pin.readFailed') });
      return;
    }
    if (stored) {
      setPinFor({ profile, stored });
      return;
    }
    await finish(profile);
  };

  const dialog = (
    <PinDialog
      open={pinFor !== null}
      mode="check"
      profileId={pinFor?.profile.id ?? ''}
      stored={pinFor?.stored}
      name={pinFor ? profileName(pinFor.profile, t) : ''}
      onDone={() => {
        const p = pinFor?.profile;
        setPinFor(null);
        if (p) void finish(p);
      }}
      onCancel={() => setPinFor(null)}
    />
  );

  return { choose, switching, dialog };
}
