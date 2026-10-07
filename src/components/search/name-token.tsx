import { View } from 'react-native';

import { Portrait } from '@/components/series/portrait';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { initials } from '@/lib/names';
import { cn } from '@/lib/utils';
import { useThemeColors } from '@/theme/use-theme-colors';

import { hueSlot } from './search-model';

/** The tint behind a character's initials, by `hueSlot` (the categorical chart colours,
 * minus chart-1: that one is the brand pink). Pale, so ink initials stay AA. */
const CHARACTER_TINT = ['bg-chart-2/20', 'bg-chart-3/20', 'bg-chart-4/20', 'bg-chart-5/20'];

/**
 * A person's or character's initials (STYLEGUIDE section 8, "Avatar, portrait, character
 * token"): an author or narrator is their `Portrait` (as on the Library's pages), a
 * character an initial on its own hue. `hidden` is the dashed eye-off token of
 * characters the listener hasn't met (it never carries a name). Decorative: the row
 * names the person.
 */
export function NameToken({
  name = '',
  kind,
  size,
  hidden,
}: {
  name?: string;
  kind: 'author' | 'narrator' | 'character';
  size: number;
  hidden?: boolean;
}) {
  const themed = useThemeColors();
  if (!hidden && kind !== 'character') return <Portrait name={name} kind={kind} size={size} />;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: size, height: size }}
      className={cn(
        'shrink-0 items-center justify-center overflow-hidden rounded-full',
        hidden
          ? 'border-[1.5px] border-dashed border-border-strong bg-muted'
          : CHARACTER_TINT[hueSlot(name)],
      )}
    >
      {hidden ? (
        <Icon name="eye-off" size={Math.round(size * 0.45)} color={themed.mutedForeground} />
      ) : (
        <Text
          className="font-display text-foreground"
          style={{ fontSize: Math.round(size * (initials(name).length > 1 ? 0.36 : 0.42)) }}
          numberOfLines={1}
        >
          {initials(name)}
        </Text>
      )}
    </View>
  );
}
