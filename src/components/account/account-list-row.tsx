import type { ReactNode } from 'react';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Icon, type IconName } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { touchTarget } from '@/components/ui/touch-target';
import { cn } from '@/lib/utils';
import { useThemeColors } from '@/theme/use-theme-colors';

/** A small button's drawn height in rem (`h-[30px]` on the web's 16 px rem), for its
 * 44 pt frame on native. */
const SM_BUTTON_REM = 30 / 16;

/**
 * One row of an account page list card (a signed-in device, a personal API key): a glyph
 * tile, the name with an optional badge, a caption, and an optional small ghost action
 * on the right with a 44 pt frame on native. Rows after the first get a hairline.
 */
export function AccountListRow({
  icon,
  title,
  badge,
  detail,
  action,
  first,
  testID,
}: {
  icon: IconName;
  title: string;
  badge?: ReactNode;
  detail: string;
  action?: { title: string; accessibilityLabel: string; loading?: boolean; onPress: () => void };
  first: boolean;
  testID?: string;
}) {
  const themed = useThemeColors();
  const target = touchTarget(SM_BUTTON_REM);
  return (
    <View
      testID={testID}
      className={cn('flex-row items-center gap-3 px-4 py-3', !first && 'border-t border-border')}
    >
      <View className="h-9 w-9 items-center justify-center rounded-[11px] bg-muted">
        <Icon name={icon} size={17} color={themed.mutedForeground} />
      </View>
      <View className="min-w-0 flex-1 gap-0.5">
        <View className="flex-row flex-wrap items-center gap-x-2 gap-y-1">
          <Text variant="label" numberOfLines={1} className="shrink">
            {title}
          </Text>
          {badge}
        </View>
        <Text variant="caption" numberOfLines={2}>
          {detail}
        </Text>
      </View>
      {action ? (
        <Button
          size="sm"
          variant="ghost"
          title={action.title}
          accessibilityLabel={action.accessibilityLabel}
          loading={action.loading}
          hitSlop={target.hitSlop}
          className={target.frameClass}
          onPress={action.onPress}
        />
      ) : null}
    </View>
  );
}
