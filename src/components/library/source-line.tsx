import { View } from 'react-native';

import { Icon, type IconName } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import type { ThemeColors } from '@/theme/tokens';
import { useThemeColors } from '@/theme/use-theme-colors';

/** Where a piece of data comes from: a glyph and a muted caption. The default is the
 * community globe (the series page's series data, a book's community chapters); a caller
 * names another glyph and colour token for another source (chapters a Bridge found in
 * the narration). A credit, not a licence notice: CC BY-SA content carries the server's
 * own text (`Attribution`). */
export function SourceLine({
  label,
  className,
  testID,
  icon = 'globe',
  iconColor = 'community',
}: {
  label: string;
  className?: string;
  testID?: string;
  icon?: IconName;
  iconColor?: keyof ThemeColors;
}) {
  const themed = useThemeColors();
  return (
    <View testID={testID} className={cn('flex-row items-center gap-1.5', className)}>
      <Icon name={icon} size={13} color={themed[iconColor]} />
      <Text variant="caption" className="shrink text-subtle-foreground">
        {label}
      </Text>
    </View>
  );
}
