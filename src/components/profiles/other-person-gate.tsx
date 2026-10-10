import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { PersonAvatar } from '@/components/house/person-avatar';
import { Button } from '@/components/ui/button';
import { Screen } from '@/components/ui/screen';
import { Text } from '@/components/ui/text';
import { backOrHome } from '@/lib/back-or-home';
import type { Profile } from '@/stores/profiles';

import { profileName } from './profiles-model';
import { useChooseProfile } from './use-choose-profile';

/**
 * A content link (`?connection=`: a widget, the Live Activity, web history, a shared link)
 * that names a connection of ANOTHER person on this device (Phase 8): never shown
 * silently. It says whose it is and offers to switch to them first (their PIN where they
 * set one); after the switch the page opens where it is (`stay`).
 */
export function OtherPersonGate({ profile }: { profile: Profile }) {
  const { t } = useTranslation();
  const { choose, switching, dialog } = useChooseProfile({ stay: true });
  const name = profileName(profile, t);
  return (
    <Screen testID="other-person-gate">
      <View className="flex-1 items-center justify-center gap-4 px-6">
        <PersonAvatar name={name} size={72} />
        <Text variant="heading" accessibilityRole="header" className="text-center">
          {t('profiles.gate.title', { name })}
        </Text>
        <Text variant="muted" className="max-w-[420px] text-center">
          {t('profiles.gate.body', { name })}
        </Text>
        <View className="flex-row flex-wrap justify-center gap-2 pt-2">
          <Button variant="ghost" title={t('profiles.gate.back')} onPress={backOrHome} />
          <Button
            testID="other-person-switch"
            title={t('profiles.gate.switch', { name })}
            loading={switching === profile.id}
            onPress={() => void choose(profile)}
          />
        </View>
      </View>
      {dialog}
    </Screen>
  );
}
