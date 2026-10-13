import { router } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { useCapabilitiesAll } from '@/api/hooks';
import { HouseSharingRow } from '@/components/house/house-sharing-row';
import { Portrait } from '@/components/series/portrait';
import { SettingRow, SettingsCard } from '@/components/settings/settings-row';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { TimeStepper } from '@/components/ui/time-stepper';
import { toast } from '@/components/ui/toast';
import { formatTimeOfDay } from '@/lib/format';
import { clearPin, readPin, type StoredPin } from '@/lib/profile-pin';
import { KIDS_BEDTIME_UNTIL } from '@/playback/auto-sleep-controller';
import {
  DEFAULT_BEDTIME,
  mayTurnOnKids,
  type Profile,
  setAskAtLaunch,
  setProfileHasPin,
  setProfileKids,
  useProfileConnections,
  useProfiles,
} from '@/stores/profiles';
import { type Connection, useSession } from '@/stores/session';

import { ADD_SOMEONE_HREF } from './connect-intent';
import { KidsLibraryPicker } from './kids-library-picker';
import { PinDialog } from './pin-dialog';
import { profileName, serversLine } from './profiles-model';
import { RenameDialog } from './rename-dialog';
import { openProfiles, useChooseProfile } from './use-choose-profile';
import { useRemovePerson } from './use-remove-person';

/**
 * The Household page's "On this device" (Phase 8; a page of its own since 8b-1,
 * `HouseholdPage`): the people on this device, each with their name, PIN, kids mode
 * (library and bedtime) and "Remove from this device"; "Who's listening?" and "Sign in
 * someone who already has an account" (the connect flow for a new person, which was "Add
 * someone"); and "Ask who's listening when the app opens".
 */
export function DevicePeople() {
  const { t } = useTranslation();
  const hydrated = useProfiles((s) => s.hydrated);
  const profiles = useProfiles((s) => s.profiles);
  const activeId = useProfiles((s) => s.activeProfileId);
  const askAtLaunch = useProfiles((s) => s.askAtLaunch);
  const connections = useSession((s) => s.connections);
  const { choose, switching, dialog: chooseDialog } = useChooseProfile();
  const removal = useRemovePerson();

  if (!hydrated) {
    return (
      <View className="items-center py-8" testID="household-device">
        <Spinner />
      </View>
    );
  }

  return (
    <View className="gap-6" testID="household-device">
      <View className="gap-3">
        <Text variant="title" accessibilityRole="header">
          {t('household.device.title')}
        </Text>
        <Text variant="muted">{t('profiles.household.intro')}</Text>
        {profiles.map((p) => (
          <PersonCard
            key={p.id}
            profile={p}
            connections={connections}
            active={p.id === activeId}
            switching={switching === p.id}
            onSwitch={() => void choose(p)}
            onRemove={(name) => void removal.request(p, name)}
          />
        ))}
        <View className="flex-row flex-wrap gap-2">
          <Button
            title={t('profiles.picker.title')}
            icon="users"
            variant="outline"
            onPress={openProfiles}
          />
          <Button
            testID="household-sign-in-existing"
            title={t('household.device.signInExisting')}
            icon="plus"
            variant="secondary"
            onPress={() => router.push(ADD_SOMEONE_HREF)}
          />
        </View>
      </View>

      <SettingsCard testID="household-ask">
        <SettingRow
          first
          label={t('profiles.household.askAtLaunch')}
          description={t('profiles.household.askAtLaunchBody')}
        >
          <Switch
            checked={askAtLaunch}
            onCheckedChange={setAskAtLaunch}
            accessibilityLabel={t('profiles.household.askAtLaunch')}
          />
        </SettingRow>
      </SettingsCard>

      {chooseDialog}
      {removal.dialog}
    </View>
  );
}

/** "Listening in the house": "Share what I'm listening to with the house", one row
 * (`HouseSharingRow`) per server of the person listening whose server has `household`; a
 * note when none does (once every server has answered). */
export function HouseSharing() {
  const { t } = useTranslation();
  const connections = useProfileConnections();
  const caps = useCapabilitiesAll();
  const sharing = connections.filter((c) => caps[c.id]?.household === true);
  const known = connections.every((c) => caps[c.id] !== undefined);
  if (sharing.length === 0 && !known) return null;
  return (
    <View className="gap-3" testID="household-sharing">
      <Text variant="title" accessibilityRole="header">
        {t('house.title')}
      </Text>
      {sharing.length === 0 ? (
        <Text variant="muted">{t('profiles.household.noSharing')}</Text>
      ) : (
        <SettingsCard>
          {sharing.map((c, i) => (
            <HouseSharingRow key={c.id} connectionId={c.id} first={i === 0} />
          ))}
        </SettingsCard>
      )}
    </View>
  );
}

/** The PIN prompt's step: `check` the current PIN (as `startPin` read it), then set a new
 * one or clear it; or `set` one. */
type PinFlow = null | { step: 'check'; then: 'set' | 'clear'; stored: StoredPin } | { step: 'set' };

/** One person on this device: name, PIN, kids mode, remove. */
function PersonCard({
  profile,
  connections,
  active,
  switching,
  onSwitch,
  onRemove,
}: {
  profile: Profile;
  connections: readonly Connection[];
  active: boolean;
  switching: boolean;
  onSwitch: () => void;
  onRemove: (name: string) => void;
}) {
  const { t } = useTranslation();
  const name = profileName(profile, t);
  const [renaming, setRenaming] = useState(false);
  const [pin, setPin] = useState<PinFlow>(null);
  const kids = profile.kids;
  // Never the last grown-up: nobody could leave kids mode (`mayTurnOnKids`).
  const kidsAllowed = useProfiles((s) => mayTurnOnKids(profile.id, s));
  const kidsLabel = t('profiles.kids.label');
  const libraryLabel = t('profiles.kids.library');
  const bedtimeLabel = t('profiles.kids.bedtime');

  // Set, Change and Remove read the secure store first, never trusting the profile's
  // mirror (`hasPin`, see `useChooseProfile`). A PIN it holds is only ever changed or
  // removed after it is given, even when the mirror lost it: never overwritten. A mirror
  // whose hash is gone is repaired and says so, instead of asking for a PIN nothing can
  // match (every try "doesn't match", then the 30 second wait). An unreadable store
  // changes nothing: it says it couldn't check.
  const startPin = async (then: 'set' | 'clear') => {
    let stored: StoredPin | null;
    try {
      stored = await readPin(profile.id);
    } catch {
      toast({ title: t('profiles.pin.readFailed') });
      return;
    }
    if (stored) {
      if (!profile.hasPin) setProfileHasPin(profile.id, true);
      setPin({ step: 'check', then, stored });
      return;
    }
    if (then === 'set' && !profile.hasPin) {
      setPin({ step: 'set' });
      return;
    }
    setProfileHasPin(profile.id, false);
    toast({ title: t('profiles.pin.noneSet', { name }) });
  };

  const pinVerified = () => {
    if (pin?.step !== 'check') return;
    if (pin.then === 'set') {
      setPin({ step: 'set' });
      return;
    }
    setPin(null);
    void clearPin(profile.id).catch(() => undefined);
  };

  return (
    <SettingsCard testID={`household-person-${profile.id}`}>
      <View className="flex-row items-center gap-3 py-3.5">
        <Portrait name={name} kind="user" size={36} ring={active} />
        <View className="min-w-0 flex-1 gap-0.5">
          <Text variant="label" numberOfLines={1} accessibilityRole="header">
            {name}
          </Text>
          <Text variant="caption" numberOfLines={1}>
            {serversLine(profile, connections, t)}
          </Text>
        </View>
        {active ? (
          <Badge variant="secondary">
            <Text>{t('profiles.status.listening')}</Text>
          </Badge>
        ) : (
          <Button
            title={t('profiles.household.switch')}
            accessibilityLabel={t('profiles.menu.switchTo', { name })}
            variant="outline"
            size="sm"
            loading={switching}
            onPress={onSwitch}
          />
        )}
      </View>

      <SettingRow label={t('profiles.rename.label')} description={name}>
        <Button
          title={t('profiles.rename.action')}
          accessibilityLabel={t('profiles.rename.title', { name })}
          variant="ghost"
          size="sm"
          icon="pen"
          onPress={() => setRenaming(true)}
        />
      </SettingRow>

      <SettingRow
        testID={`household-pin-${profile.id}`}
        label={t('profiles.pin.label')}
        description={
          profile.hasPin ? t('profiles.pin.onBody', { name }) : t('profiles.pin.offBody')
        }
      >
        {profile.hasPin ? (
          <View className="flex-row gap-1">
            <Button
              title={t('profiles.pin.change')}
              accessibilityLabel={t('profiles.pin.changeA11y', { name })}
              variant="ghost"
              size="sm"
              onPress={() => void startPin('set')}
            />
            <Button
              title={t('profiles.pin.remove')}
              accessibilityLabel={t('profiles.pin.removeA11y', { name })}
              variant="ghost"
              size="sm"
              onPress={() => void startPin('clear')}
            />
          </View>
        ) : (
          <Button
            title={t('profiles.pin.set')}
            accessibilityLabel={t('profiles.pin.setA11y', { name })}
            variant="ghost"
            size="sm"
            icon="key"
            onPress={() => void startPin('set')}
          />
        )}
      </SettingRow>

      <SettingRow
        label={kidsLabel}
        description={kidsAllowed ? t('profiles.kids.body') : t('profiles.kids.needsGrownUp')}
      >
        <Switch
          checked={!!kids}
          disabled={!kidsAllowed}
          onCheckedChange={(on) =>
            setProfileKids(profile.id, on ? { bedtime: DEFAULT_BEDTIME } : undefined)
          }
          accessibilityLabel={t('profiles.kids.switchA11y', { name })}
        />
      </SettingRow>
      {kids ? (
        <>
          <SettingRow label={libraryLabel} description={t('profiles.kids.libraryBody')}>
            <KidsLibraryPicker profile={profile} label={libraryLabel} />
          </SettingRow>
          <SettingRow
            label={bedtimeLabel}
            description={t('profiles.kids.bedtimeBody', {
              until: formatTimeOfDay(KIDS_BEDTIME_UNTIL),
            })}
          >
            <TimeStepper
              value={kids.bedtime}
              onChange={(bedtime) => setProfileKids(profile.id, { ...kids, bedtime })}
              label={bedtimeLabel}
            />
          </SettingRow>
        </>
      ) : null}

      <SettingRow
        control="block"
        label={t('profiles.remove.label')}
        description={t('profiles.remove.hint', { name })}
      >
        <Button
          testID={`remove-person-${profile.id}`}
          title={t('profiles.remove.action')}
          accessibilityLabel={t('profiles.remove.title', { name })}
          variant="destructive-outline"
          size="sm"
          icon="logout"
          className="self-start"
          onPress={() => onRemove(name)}
        />
      </SettingRow>

      <RenameDialog
        open={renaming}
        profileId={profile.id}
        name={name}
        onClose={() => setRenaming(false)}
      />
      <PinDialog
        open={pin !== null}
        mode={pin?.step ?? 'check'}
        profileId={profile.id}
        stored={pin?.step === 'check' ? pin.stored : undefined}
        name={name}
        title={pin?.step === 'check' ? t('profiles.pin.currentTitle', { name }) : undefined}
        onDone={pin?.step === 'set' ? () => setPin(null) : pinVerified}
        onCancel={() => setPin(null)}
      />
    </SettingsCard>
  );
}
