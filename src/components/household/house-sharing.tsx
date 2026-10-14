import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { useCapabilitiesAll } from '@/api/hooks';
import { HouseSharingRow } from '@/components/house/house-sharing-row';
import { SettingsCard } from '@/components/settings/settings-row';
import { SectionTitle } from '@/components/ui/section-title';
import { Text } from '@/components/ui/text';
import { useProfileConnections } from '@/stores/profiles';

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
      <SectionTitle title={t('house.title')} />
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
