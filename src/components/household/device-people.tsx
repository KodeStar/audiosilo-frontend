import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { apiErrorKind } from '@/api/client';
import { CapabilityError, useMemberSession } from '@/api/hooks';
import { memberOwnerHere, renewMemberHere } from '@/components/connect/add-member-here';
import { kidsManager } from '@/components/kids/kids-model';
import { useKidsSharedShelf } from '@/components/kids/use-kids';
import { reconnectConnection } from '@/components/layout/reconnect-banner';
import { openAddSomeone } from '@/components/profiles/connect-intent';
import { KidsLibraryPicker } from '@/components/profiles/kids-library-picker';
import { PinDialog } from '@/components/profiles/pin-dialog';
import { profileName, serversLine } from '@/components/profiles/profiles-model';
import { RenameDialog } from '@/components/profiles/rename-dialog';
import { openProfiles, useChooseProfile } from '@/components/profiles/use-choose-profile';
import { useRemovePerson } from '@/components/profiles/use-remove-person';
import { SettingRow, SettingsCard } from '@/components/settings/settings-row';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SectionTitle } from '@/components/ui/section-title';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { TimeStepper } from '@/components/ui/time-stepper';
import { toast } from '@/components/ui/toast';
import { formatTimeOfDay } from '@/lib/format';
import { clearPin, readPinMirrored, type StoredPin } from '@/lib/profile-pin';
import { KIDS_BEDTIME_UNTIL } from '@/playback/listener-settings';
import {
  connectionsOfProfile,
  DEFAULT_BEDTIME,
  mayTurnOnKids,
  renameProfile,
  type Profile,
  setAskAtLaunch,
  setProfileKids,
  useProfiles,
} from '@/stores/profiles';
import { type Connection, useSession } from '@/stores/session';

import { PersonHeader, RenameRow } from './person-rows';

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

  // The dialogs sit outside the gapped column: a closed dialog still mounts an empty view,
  // which a flex gap would space out like a section.
  return (
    <View testID="household-device">
      <View className="gap-6">
        <View className="gap-3">
          <SectionTitle title={t('household.device.title')} sub={t('profiles.household.intro')} />
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
              onPress={openAddSomeone}
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
      </View>

      {chooseDialog}
      {removal.dialog}
    </View>
  );
}

/**
 * "Signed out" on a person whose sign-in to `connection`'s server ended (8b-1, D1): kids
 * mode only asks for a grown-up, and this is where one signs them in again. A household
 * member the person listening manages there is signed in again at once with a session
 * the owner mints (`memberOwnerHere`, `useMemberSession`, `renewMemberHere`: a kid has no
 * password to type); anyone else, and anyone on a server that was reset, goes through the
 * connect flow's sign-in for that connection (as the reconnect banner does), which keeps
 * them the person they were.
 */
function SignInAgainRow({ name, connection }: { name: string; connection: Connection }) {
  const { t } = useTranslation();
  // A reset server no longer knows the member (nor the owner's old sign-in): signing in
  // again there is the connect flow's.
  const owner = useSession((s) =>
    connection.needsReconnect === 'auth' ? memberOwnerHere(connection, s.connections) : null,
  );
  const session = useMemberSession(owner?.id ?? '');
  const onPress = async () => {
    if (!owner) {
      await reconnectConnection(connection);
      return;
    }
    try {
      await renewMemberHere(await session.mutateAsync(connection.user.id));
      toast({ title: t('profiles.signIn.done', { name }) });
    } catch (e) {
      if (e instanceof CapabilityError) return;
      toast({
        title:
          apiErrorKind(e) === 'too_many'
            ? t('common.tooManyTries')
            : t('profiles.signIn.failed', { name }),
      });
    }
  };
  return (
    <SettingRow
      testID={`household-signed-out-${connection.id}`}
      label={t('profiles.signIn.label')}
      description={t('profiles.signIn.body', { name, server: connection.name })}
    >
      <Button
        title={t('profiles.signIn.action')}
        accessibilityLabel={t('profiles.signIn.a11y', { name })}
        variant="outline"
        size="sm"
        icon="key"
        loading={session.isPending}
        onPress={() => void onPress()}
      />
    </SettingRow>
  );
}

/**
 * Kids mode's library for `profile`: the picker (`KidsLibraryPicker`), beside its label on
 * a wide card and under it on a phone, where a message (no libraries, couldn't load) left
 * the label one letter wide (8b-1, D7). Hidden while kids mode shows the collections the
 * account's owner shares (`useKidsSharedShelf`, 8b-1 D6): the pick is not used then. Also
 * hidden while that can't be told (the kid's sign-in ended, or the shared collections
 * couldn't be read): the libraries would only fail to load (the signed-out row above says
 * what to do).
 */
function KidsLibraryRow({ profile, manager }: { profile: Profile; manager: string | null }) {
  const { t } = useTranslation();
  const shelf = useKidsSharedShelf(profile);
  const label = t('profiles.kids.library');
  if (shelf !== 'library') return null;
  return (
    <SettingRow
      testID={`household-kids-library-${profile.id}`}
      control="wide"
      label={label}
      description={
        manager
          ? t('profiles.kids.libraryBodyMember', { owner: manager })
          : t('profiles.kids.libraryBody')
      }
    >
      <KidsLibraryPicker profile={profile} label={label} manager={manager} />
    </SettingRow>
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
  // A sign-in of theirs that ended here (a revoked session, a deleted account, a server
  // that was reset): signing them in again is this page's (a grown-up's), never kids mode's.
  const own = useMemo(
    () => connectionsOfProfile(connections, profile.connectionIds),
    [connections, profile.connectionIds],
  );
  // Signed in again, what failed meanwhile is read again (`ApiProvider`).
  const signedOut = own.find((c) => c.needsReconnect) ?? null;
  // A household member's account (Phase 8b-1): kids mode shows what the person who
  // manages it shares, so its lines name them, never "ask the server's admin".
  const manager = kidsManager(profile, connections);
  // Never the last grown-up: nobody could leave kids mode (`mayTurnOnKids`).
  const kidsAllowed = useProfiles((s) => mayTurnOnKids(profile.id, s));
  const kidsLabel = t('profiles.kids.label');
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
      stored = await readPinMirrored(profile);
    } catch {
      toast({ title: t('profiles.pin.readFailed') });
      return;
    }
    if (stored) {
      setPin({ step: 'check', then, stored });
      return;
    }
    // None, and the mirror said none: set one. Else the mirror had lost its hash (repaired).
    if (then === 'set' && !profile.hasPin) {
      setPin({ step: 'set' });
      return;
    }
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
      <PersonHeader name={name} detail={serversLine(profile, connections, t)} ring={active}>
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
      </PersonHeader>

      {signedOut ? <SignInAgainRow name={name} connection={signedOut} /> : null}

      <RenameRow name={name} onRename={() => setRenaming(true)} />

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
        description={
          !kidsAllowed
            ? t('profiles.kids.needsGrownUp')
            : manager
              ? t('profiles.kids.bodyMember', { owner: manager })
              : t('profiles.kids.body')
        }
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
          <KidsLibraryRow profile={profile} manager={manager} />
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
          accessibilityLabel={t('profiles.remove.a11y', { name })}
          variant="destructive-outline"
          size="sm"
          icon="logout"
          className="self-start"
          onPress={() => onRemove(name)}
        />
      </SettingRow>

      <RenameDialog
        open={renaming}
        name={name}
        onSave={async (next) => {
          renameProfile(profile.id, next);
          return true;
        }}
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
