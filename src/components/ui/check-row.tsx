import { Platform, Pressable, View } from 'react-native';

import { Icon } from '@/components/ui/icon';
import { Skeleton } from '@/components/ui/skeleton';
import { FOCUS_RING_CLASS, Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { useThemeColors } from '@/theme/use-theme-colors';

const checkRowClass = cn(
  'min-h-[48px] flex-row items-center gap-3 rounded-xl px-3 active:bg-accent hover:bg-accent',
  Platform.select({
    web: `cursor-pointer ${FOCUS_RING_CLASS}`,
  }),
);

/** A checkbox row (a share target, a collection holding the book or shared with a
 * household member, "Also sign out" on a device). `checked` undefined: still loading. */
export function CheckRow({
  label,
  detail,
  checked,
  busy,
  wrap = false,
  testID,
  onPress,
}: {
  label: string;
  detail?: string;
  checked: boolean | undefined;
  busy?: boolean;
  /** The label wraps (a sentence) instead of keeping to one line (a name). */
  wrap?: boolean;
  testID?: string;
  onPress: () => void;
}) {
  const themed = useThemeColors();
  return (
    <Pressable
      testID={testID}
      role="checkbox"
      aria-checked={!!checked}
      accessibilityState={{ checked: !!checked, busy }}
      accessibilityLabel={detail ? `${label}, ${detail}` : label}
      disabled={checked === undefined || busy}
      onPress={onPress}
      className={checkRowClass}
    >
      <View
        className={cn(
          'h-5 w-5 items-center justify-center rounded-md border',
          checked ? 'border-primary bg-primary' : 'border-border-strong bg-card',
        )}
      >
        {checked ? <Icon name="check" size={13} color={themed.primaryForeground} /> : null}
      </View>
      <View className="flex-1">
        <Text variant="label" numberOfLines={wrap ? undefined : 1}>
          {label}
        </Text>
        {detail ? (
          <Text variant="caption" numberOfLines={1}>
            {detail}
          </Text>
        ) : null}
      </View>
      {checked === undefined ? <Skeleton className="h-3 w-10 rounded-sm" /> : null}
    </Pressable>
  );
}
