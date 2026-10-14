import { useTranslation } from 'react-i18next';
import { useEffect } from 'react';
import { BackHandler, Platform, ScrollView, View } from 'react-native';

import { Portrait, RING_ROOM } from '@/components/series/portrait';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Icon } from '@/components/ui/icon';
import { SafeAreaView } from '@/components/ui/safe-area-view';
import { Screen } from '@/components/ui/screen';
import { Spinner } from '@/components/ui/spinner';
import { FOCUS_RING_CLASS, Text } from '@/components/ui/text';
import { openHousehold } from '@/lib/open';
import { useLayout } from '@/lib/layout';
import { cn } from '@/lib/utils';
import { type Profile, useActiveProfile, useMustChoose, useProfiles } from '@/stores/profiles';
import { type Connection, useSession } from '@/stores/session';
import { useThemeColors } from '@/theme/use-theme-colors';

import { mayAddPerson, openAddSomeone } from './connect-intent';
import { profileName, profileStatus, takeLaunchDecision } from './profiles-model';
import { forgetPickerOpener, leavePicker, useChooseProfile } from './use-choose-profile';

/**
 * "Who's listening?" (`/profiles`, a full-screen root route; STYLEGUIDE section 8 "Profile
 * picker"): everyone on this device as a large avatar with a one-line status, the one
 * listening now ringed, and "Add someone" (the connect flow for a new person). Choosing
 * someone with a PIN asks for it; choosing someone else switches and goes Home. Shown at a
 * cold launch with two or more people and "Ask who's listening when the app opens" on,
 * and from the profile menu, the Me tab and the Household page, which "Manage household"
 * opens (not while someone must be chosen, nor for a kids profile, whose app is `/kids`).
 */
export function ProfilesScreen() {
  const { t } = useTranslation();
  const phone = useLayout() === 'phone';
  const themed = useThemeColors();
  const hydrated = useProfiles((s) => s.hydrated);
  const profiles = useProfiles((s) => s.profiles);
  const activeId = useProfiles((s) => s.activeProfileId);
  // The person listening left: someone must be chosen, so there is no way out but
  // choosing (persisted, so a reload is the same).
  const required = useMustChoose();
  const status = useSession((s) => s.status);
  const connections = useSession((s) => s.connections);
  const { choose, switching, dialog } = useChooseProfile();
  const size = phone ? 76 : 96;
  const canAdd = useProfiles(mayAddPerson);
  const kids = !!useActiveProfile()?.kids;

  // On screen, it IS this launch's "Who's listening?" (a cold load of /profiles, a reload
  // while it was open): the auth gate must not ask again once it is closed.
  useEffect(() => {
    takeLaunchDecision();
    return forgetPickerOpener;
  }, []);

  // Android's back can't leave it either while someone must be chosen.
  useEffect(() => {
    if (!required) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => sub.remove();
  }, [required]);

  if (!hydrated || status === 'loading') {
    return (
      <Screen testID="profiles-loading">
        <Spinner center />
      </Screen>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-background" testID="profiles-screen">
      <View className="min-h-[44px] flex-row justify-end px-2 pt-1">
        {required ? null : (
          <Button
            variant="ghost"
            size="sm"
            icon="close"
            title={t('common.close')}
            accessibilityLabel={t('profiles.picker.close')}
            onPress={leavePicker}
            testID="profiles-close"
          />
        )}
      </View>
      <ScrollView
        contentContainerClassName="flex-grow items-center justify-center px-4 pb-10"
        keyboardShouldPersistTaps="handled"
      >
        {profiles.length === 0 ? (
          <EmptyState
            icon="users"
            title={t('profiles.picker.emptyTitle')}
            hint={t('profiles.picker.emptyHint')}
            action={{
              label: t('profiles.add.label'),
              icon: 'plus',
              onPress: openAddSomeone,
            }}
          />
        ) : (
          <>
            <View className="max-w-[440px] items-center gap-2 pb-8 pt-4">
              {/* "This device is shared" only once it is (8b-1, D12). */}
              {profiles.length > 1 ? (
                <Text variant="eyebrow">{t('profiles.picker.eyebrow')}</Text>
              ) : null}
              <Text
                variant={phone ? 'display' : 'display-xl'}
                accessibilityRole="header"
                className="text-center"
              >
                {t('profiles.picker.title')}
              </Text>
              <Text variant="muted" className="text-center">
                {t('profiles.picker.lead')}
              </Text>
            </View>
            <View
              className={cn(
                'max-w-[820px] flex-row flex-wrap justify-center',
                phone ? 'gap-x-4 gap-y-6' : 'gap-x-8 gap-y-10',
              )}
              accessibilityRole="list"
            >
              {profiles.map((p) => (
                <PersonButton
                  key={p.id}
                  profile={p}
                  connections={connections}
                  active={p.id === activeId}
                  switching={switching === p.id}
                  disabled={switching !== null}
                  size={size}
                  onPress={() => void choose(p)}
                />
              ))}
              <AnimatedPressable
                testID="profiles-add"
                onPress={openAddSomeone}
                disabled={switching !== null || !canAdd}
                accessibilityRole="button"
                accessibilityLabel={t('profiles.add.a11y')}
                className={cn(
                  'items-center gap-2 rounded-card p-2',
                  Platform.select({ web: `cursor-pointer ${FOCUS_RING_CLASS}` }),
                )}
                style={{ width: size + 40 }}
              >
                <View
                  className="items-center justify-center rounded-full border-2 border-dashed border-border-strong bg-muted"
                  style={{ width: size, height: size, margin: RING_ROOM }}
                >
                  <Icon name="plus" size={Math.round(size * 0.32)} color={themed.mutedForeground} />
                </View>
                <Text variant="title" className="text-center">
                  {t('profiles.add.label')}
                </Text>
                <Text variant="caption" className="text-center">
                  {t(canAdd ? 'profiles.add.hint' : 'profiles.add.chooseAdult')}
                </Text>
              </AnimatedPressable>
            </View>
            {required || kids ? null : (
              <Button
                testID="profiles-manage"
                variant="outline"
                icon="users"
                className="mt-8"
                title={t('household.manage')}
                disabled={switching !== null}
                onPress={openHousehold}
              />
            )}
          </>
        )}
      </ScrollView>
      {dialog}
    </SafeAreaView>
  );
}

function PersonButton({
  profile,
  connections,
  active,
  switching,
  disabled,
  size,
  onPress,
}: {
  profile: Profile;
  connections: readonly Connection[];
  active: boolean;
  switching: boolean;
  disabled: boolean;
  size: number;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const name = profileName(profile, t);
  const status = profileStatus(profile, connections, active, t);
  const label = [name, status, profile.hasPin && !active ? t('profiles.picker.needsPin') : null]
    .filter(Boolean)
    .join(', ');
  return (
    <AnimatedPressable
      testID={`profile-${profile.id}`}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active, busy: switching, disabled }}
      className={cn(
        'items-center gap-2 rounded-card p-2',
        Platform.select({ web: `cursor-pointer ${FOCUS_RING_CLASS}` }),
      )}
      style={{ width: size + 40 }}
    >
      <View>
        <Portrait name={name} kind="user" size={size} ring={active} />
        {switching ? (
          <View
            className="absolute items-center justify-center rounded-full bg-overlay"
            style={{ left: RING_ROOM, top: RING_ROOM, width: size, height: size }}
          >
            <Spinner />
          </View>
        ) : null}
      </View>
      <View className="flex-row items-center gap-1.5">
        <Text variant="title" numberOfLines={1} className="shrink text-center">
          {name}
        </Text>
        {profile.hasPin ? <Icon name="key" size={13} color={themed.mutedForeground} /> : null}
      </View>
      <Text variant="caption" numberOfLines={2} className="text-center">
        {status}
      </Text>
    </AnimatedPressable>
  );
}
