import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { PinDialog } from '@/components/profiles/pin-dialog';
import { profileName } from '@/components/profiles/profiles-model';
import { toast } from '@/components/ui/toast';
import { readPinMirrored } from '@/lib/profile-pin';
import type { Profile } from '@/stores/profiles';

/**
 * Set a PIN for a person on this device (after adding a kid: the owner's own, so the kid
 * can't switch to them without it). The same rule as the Household page's Set a PIN: the
 * secure store is read first, never the profile's mirror, so a PIN it holds is never
 * overwritten (the mirror is repaired and the listener told); an unreadable store changes
 * nothing. Render `dialog` somewhere in the screen (it portals).
 */
export function useSetPin(): { start: (profile: Profile) => Promise<void>; dialog: ReactNode } {
  const { t } = useTranslation();
  const [profile, setProfile] = useState<Profile | null>(null);

  const start = async (p: Profile) => {
    try {
      if (await readPinMirrored(p)) {
        toast({ title: t('household.pin.already', { name: profileName(p, t) }) });
        return;
      }
    } catch {
      toast({ title: t('profiles.pin.readFailed') });
      return;
    }
    setProfile(p);
  };

  const dialog = (
    <PinDialog
      open={profile !== null}
      mode="set"
      profileId={profile?.id ?? ''}
      name={profile ? profileName(profile, t) : ''}
      onDone={() => setProfile(null)}
      onCancel={() => setProfile(null)}
    />
  );
  return { start, dialog };
}
