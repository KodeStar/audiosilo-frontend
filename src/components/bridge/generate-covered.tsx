import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/theme/use-theme-colors';

/**
 * Why the book page offers no Generate when the community already has both characters
 * and recaps (Bridge Phase 1e, `GenerateModel.covered`): one quiet line where the action
 * would be (the same shape as `TranscodeNote` beside it), with "See characters" opening
 * the Characters tab. The page mounts it only when `covered`, which `generateOffer` never
 * gives without the permission, so a listener never sees it.
 */
export function GenerateCovered({ onOpen }: { onOpen: () => void }) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  return (
    <View
      testID="generate-covered"
      className="max-w-[560px] flex-row flex-wrap items-center gap-x-1.5 gap-y-1"
    >
      <Icon name="users" size={13} color={themed.mutedForeground} />
      <Text variant="caption" className="min-w-0 shrink">
        {t('bridge.generate.covered')}
      </Text>
      <Button
        testID="generate-covered-open"
        variant="link"
        size="sm"
        title={t('bridge.generate.seeCharacters')}
        onPress={onOpen}
      />
    </View>
  );
}
