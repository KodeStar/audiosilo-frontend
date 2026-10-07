import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, Pressable, ScrollView } from 'react-native';

import { HORIZONTAL_SCROLLER } from '@/components/ui/horizontal-scroller';
import { Icon } from '@/components/ui/icon';
import { FOCUS_RING_CLASS, Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { useThemeColors } from '@/theme/use-theme-colors';

export type BookCrumb = { label: string; onPress?: () => void };

/**
 * Where the book sits in its library, as quiet links over the hero: the library, each
 * folder above the book, then the book's own folder or file name (the place, not a
 * link). Muted ink, never pink (the hero's one pink thing is its progress bar); a
 * sideways scroller when the path is longer than the row.
 */
export function BookCrumbs({ crumbs }: { crumbs: BookCrumb[] }) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const last = crumbs.length - 1;
  return (
    <ScrollView
      horizontal
      style={HORIZONTAL_SCROLLER}
      showsHorizontalScrollIndicator={false}
      contentContainerClassName="flex-row items-center gap-1.5"
      accessibilityLabel={t('book.page.crumbs')}
    >
      {crumbs.map((c, i) => (
        <Fragment key={`${c.label}-${i}`}>
          {i > 0 ? <Icon name="chevron-right" size={11} color={themed.subtleForeground} /> : null}
          {c.onPress && i < last ? (
            <Pressable
              onPress={c.onPress}
              accessibilityRole="link"
              hitSlop={10}
              className={cn(
                'rounded-sm active:opacity-70',
                Platform.select({ web: `cursor-pointer hover:underline ${FOCUS_RING_CLASS}` }),
              )}
            >
              <Text variant="muted" numberOfLines={1}>
                {c.label}
              </Text>
            </Pressable>
          ) : (
            <Text numberOfLines={1} className="font-sans-semibold text-sm text-foreground">
              {c.label}
            </Text>
          )}
        </Fragment>
      ))}
    </ScrollView>
  );
}
