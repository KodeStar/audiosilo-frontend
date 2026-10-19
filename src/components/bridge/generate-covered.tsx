import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { useThemeColors } from '@/theme/use-theme-colors';

import type { GenerateModel } from './use-generate';

/**
 * Why Generate isn't offered when the community already has both characters and recaps
 * (Bridge Phase 1e, `generateOffer`'s `covered`): one quiet line where the action would
 * be, with "See characters" when the surface can open them (`onOpen`). Admin-only like
 * the action itself: nothing without `model.allowed`, so a listener never sees it.
 */
export function GenerateCovered({
  model,
  onOpen,
  className,
}: {
  model: Pick<GenerateModel, 'allowed' | 'offer'>;
  onOpen?: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  if (!model.allowed || model.offer !== 'covered') return null;
  return (
    <View
      testID="generate-covered"
      className={cn('max-w-[560px] flex-row flex-wrap items-center gap-x-2 gap-y-1', className)}
    >
      <Icon name="users" size={14} color={themed.mutedForeground} />
      <Text variant="caption" className="min-w-0 shrink">
        {t('bridge.generate.covered')}
      </Text>
      {onOpen ? (
        <Button
          testID="generate-covered-open"
          variant="link"
          size="sm"
          title={t('bridge.generate.seeCharacters')}
          onPress={onOpen}
        />
      ) : null}
    </View>
  );
}
