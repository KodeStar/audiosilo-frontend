import { useIsFocused } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { useToday } from '@/lib/use-day-label';

import { houseCopy, houseRowKey, rowsForBook } from './house-model';
import { PersonAvatar } from './person-avatar';
import { useHouseRows } from './use-house-rows';

const AVATAR = 28;

/**
 * The book page's "In the house" card (the prototype's aside card): the other people on
 * this book's server who share and are on THIS book (`(library_id, path)`), each with
 * their avatar, name and state line. Renders nothing when nobody is (or while it loads,
 * on an error, or while the listener doesn't share). Uses the same cached answer as Home's
 * row, polled only while the page is focused.
 */
export function InTheHouseCard({
  connectionId,
  libraryId,
  path,
}: {
  connectionId: string;
  libraryId: number;
  path: string;
}) {
  const { t } = useTranslation();
  const focused = useIsFocused();
  const rows = rowsForBook(useHouseRows(connectionId, focused), libraryId, path);
  const today = useToday();
  if (rows.length === 0) return null;
  return (
    <Card testID="in-the-house" className="gap-3">
      <Text variant="eyebrow" accessibilityRole="header">
        {t('house.inTheHouse')}
      </Text>
      {rows.map((r) => {
        const copy = houseCopy(r, today, t);
        return (
          <View
            key={houseRowKey(r)}
            accessible
            accessibilityLabel={copy.label}
            className="flex-row items-center gap-2.5"
          >
            <PersonAvatar name={r.username} size={AVATAR} />
            <View className="min-w-0 flex-1">
              <Text variant="label" numberOfLines={1}>
                {r.username}
              </Text>
              <Text variant="caption" numberOfLines={2}>
                {copy.line}
              </Text>
            </View>
          </View>
        );
      })}
    </Card>
  );
}
