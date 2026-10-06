import { useTranslation } from 'react-i18next';
import { Platform, Pressable, View } from 'react-native';

import { FOCUS_RING_CLASS, Text } from '@/components/ui/text';
import { RAIL_LETTERS } from '@/lib/alpha-sections';
import { cn } from '@/lib/utils';

/**
 * The A-Z rail beside a title-ordered grid (STYLEGUIDE section 2, Library): one button
 * per letter, the letters with no books dimmed and disabled, '#' at the foot when
 * something files there. Compact on a phone (a slim right rail). Pressing jumps.
 */
export function AzRail({
  present,
  onJump,
  compact,
}: {
  present: ReadonlySet<string>;
  onJump: (letter: string) => void;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const letters = present.has('#') ? [...RAIL_LETTERS, '#'] : RAIL_LETTERS;
  return (
    <View
      role="navigation"
      accessibilityLabel={t('library.books.rail')}
      className={cn('items-center', compact ? 'w-[18px]' : 'w-[26px] py-1.5')}
    >
      {letters.map((l) => {
        const on = present.has(l);
        return (
          <Pressable
            key={l}
            disabled={!on}
            onPress={() => onJump(l)}
            hitSlop={compact ? { left: 10, right: 4 } : { left: 6, right: 6 }}
            accessibilityRole="button"
            accessibilityLabel={t('library.browse.jumpTo', { letter: l })}
            accessibilityState={{ disabled: !on }}
            className={cn(
              'items-center justify-center rounded-[5px] active:bg-primary',
              compact ? 'h-[15px] w-[18px]' : 'h-[17px] w-[22px]',
              Platform.select({
                web: `cursor-pointer hover:bg-accent disabled:cursor-default ${FOCUS_RING_CLASS}`,
              }),
            )}
          >
            <Text
              className={cn(
                'font-sans-bold',
                compact ? 'text-[9.5px]' : 'text-[10.5px]',
                on ? 'text-muted-foreground' : 'text-subtle-foreground opacity-40',
              )}
            >
              {l}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
