import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, Pressable, View } from 'react-native';

import type { Crumb } from '@/components/ui/breadcrumbs';
import { Icon } from '@/components/ui/icon';
import { FOCUS_RING_CLASS, Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { useThemeColors } from '@/theme/use-theme-colors';

/**
 * Where the book sits in its library, as quiet links over the hero: the library, each
 * folder above the book, then the book's title (the place, not a link: `bookCrumbs`).
 * Muted ink, never pink (the hero's one pink thing is its progress bar). One row that
 * never scrolls or clips: when the path is longer than the row every crumb gives way
 * (the longest most) and ends in an ellipsis (PLAYER-08). The full path stays readable
 * in the Details tab.
 */
export function BookCrumbs({ crumbs }: { crumbs: Crumb[] }) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const last = crumbs.length - 1;
  return (
    <View
      testID="book-crumbs"
      className="min-w-0 flex-row items-center gap-1.5"
      accessibilityLabel={t('book.page.crumbs')}
    >
      {crumbs.map((c, i) => (
        <Fragment key={`${c.label}-${i}`}>
          {i > 0 ? (
            <View className="shrink-0">
              <Icon name="chevron-right" size={11} color={themed.subtleForeground} />
            </View>
          ) : null}
          {c.onPress && i < last ? (
            <Pressable
              onPress={c.onPress}
              accessibilityRole="link"
              hitSlop={10}
              className={cn(
                'min-w-0 shrink rounded-sm active:opacity-70',
                Platform.select({ web: `cursor-pointer hover:underline ${FOCUS_RING_CLASS}` }),
              )}
            >
              <Text variant="muted" numberOfLines={1}>
                {c.label}
              </Text>
            </Pressable>
          ) : (
            <Text
              numberOfLines={1}
              className="min-w-0 shrink font-sans-semibold text-sm text-foreground"
            >
              {c.label}
            </Text>
          )}
        </Fragment>
      ))}
    </View>
  );
}
