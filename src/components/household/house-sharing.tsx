import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { useCapabilitiesAllRead } from '@/api/hooks';
import { HouseSharingRow } from '@/components/house/house-sharing-row';
import { LoadError } from '@/components/library/books/book-states';
import { SettingsCard } from '@/components/settings/settings-row';
import { SectionTitle } from '@/components/ui/section-title';
import { Text } from '@/components/ui/text';
import { joinNames } from '@/lib/names';
import { serverDisplayName } from '@/lib/server-display-name';
import { useProfileConnections } from '@/stores/profiles';
import { useSession } from '@/stores/session';

/** "Listening in the house": "Share what I'm listening to with the house", one row
 * (`HouseSharingRow`) per server of the person listening whose server has `household`; once
 * every server has answered or failed (fe#236), a note when none does, or, when a server's
 * flags could not be read, which one with a Retry. */
export function HouseSharing() {
  const { t } = useTranslation();
  const connections = useProfileConnections();
  const saved = useSession((s) => s.connections);
  const { caps, failed, retry, reading } = useCapabilitiesAllRead();
  const sharing = connections.filter((c) => caps[c.id]?.household === true);
  const unread = connections.filter((c) => failed.includes(c.id));
  const settled = connections.every((c) => caps[c.id] !== undefined || failed.includes(c.id));
  if (sharing.length === 0 && !settled) return null;
  return (
    <View className="gap-3" testID="household-sharing">
      <SectionTitle title={t('house.title')} />
      {sharing.length > 0 ? (
        <SettingsCard>
          {sharing.map((c, i) => (
            <HouseSharingRow key={c.id} connectionId={c.id} first={i === 0} />
          ))}
        </SettingsCard>
      ) : unread.length > 0 ? (
        <LoadError
          compact
          title={t('profiles.household.checkFailed', {
            server: joinNames(
              unread.map((c) => serverDisplayName(c, saved)),
              t,
            ),
            // "Home and Maya offer this": the verb agrees with the servers named.
            count: unread.length,
          })}
          retryLabel={t('common.retry')}
          onRetry={retry}
          retrying={reading}
        />
      ) : (
        <Text variant="muted">{t('profiles.household.noSharing')}</Text>
      )}
    </View>
  );
}
