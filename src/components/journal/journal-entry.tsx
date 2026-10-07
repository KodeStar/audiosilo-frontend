import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Icon } from '@/components/ui/icon';
import { PressableRow } from '@/components/ui/row-surface';
import { Text } from '@/components/ui/text';
import { useOpen } from '@/lib/open';
import { useThemeColors } from '@/theme/use-theme-colors';

/** The phone Me tab's way into the Journal, at the top of its screen (until Phase 5's
 * You hub gives the Journal its own section). */
export function JournalEntryRow() {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const { openJournal } = useOpen();
  return (
    <PressableRow
      onPress={() => openJournal()}
      accessibilityRole="link"
      accessibilityLabel={t('journal.title')}
      accessibilityHint={t('journal.entryHint')}
      testID="journal-entry"
      className="flex-row items-center gap-3 px-4 py-3.5"
    >
      <Icon name="history" size={20} color={themed.foreground} />
      <View className="flex-1 gap-0.5">
        <Text variant="label">{t('journal.title')}</Text>
        <Text variant="caption">{t('journal.entryHint')}</Text>
      </View>
      <Icon name="chevron-right" size={16} color={themed.mutedForeground} />
    </PressableRow>
  );
}
