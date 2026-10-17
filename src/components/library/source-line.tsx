import { View } from 'react-native';

import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { useThemeColors } from '@/theme/use-theme-colors';

/** Where a piece of data comes from: the community globe and a muted caption (the series
 * page's series data, a book's community chapters), or with `server` the server's own
 * glyph in the caption's colour (chapters a Bridge found in the narration). A credit, not a
 * licence notice: CC BY-SA content carries the server's own text (`Attribution`). */
export function SourceLine({
  label,
  className,
  testID,
  server = false,
}: {
  label: string;
  className?: string;
  testID?: string;
  server?: boolean;
}) {
  const themed = useThemeColors();
  return (
    <View testID={testID} className={cn('flex-row items-center gap-1.5', className)}>
      <Icon
        name={server ? 'server' : 'globe'}
        size={13}
        color={server ? themed.subtleForeground : themed.community}
      />
      <Text variant="caption" className="shrink text-subtle-foreground">
        {label}
      </Text>
    </View>
  );
}
