import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { PersonAvatar } from '@/components/house/person-avatar';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { useActiveProfile, useProfiles } from '@/stores/profiles';
import { useSession } from '@/stores/session';

import { profileName } from './profiles-model';
import { openProfiles } from './use-choose-profile';

/**
 * "Listening as <name>" with the way to "Who's listening?" (switch, add someone): the
 * phone's place for what the tablet and desktop profile menu offers (the Me tab's Account
 * segment). Nothing before the profiles have loaded.
 */
export function ListeningAsCard() {
  const { t } = useTranslation();
  const active = useActiveProfile();
  const count = useProfiles((s) => s.profiles.length);
  const connections = useSession((s) => s.connections);
  if (!active) return null;
  const name = profileName(active, connections, t);
  return (
    <Card className="flex-row items-center gap-3 p-4" testID="listening-as">
      <View style={{ margin: 4 }}>
        <PersonAvatar name={name} size={40} ring />
      </View>
      <View className="min-w-0 flex-1 gap-0.5">
        <Text variant="eyebrow">{t('profiles.menu.listeningAs')}</Text>
        <Text variant="title" numberOfLines={1}>
          {name}
        </Text>
      </View>
      <Button
        title={count > 1 ? t('profiles.household.switch') : t('profiles.add.label')}
        accessibilityLabel={t('profiles.picker.title')}
        variant="outline"
        size="sm"
        icon={count > 1 ? 'users' : 'plus'}
        onPress={openProfiles}
      />
    </Card>
  );
}
