import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import type { Book } from '@/api/types';
import {
  descriptionIsLong,
  DisclosureChevron,
  type MatchedBookMeta,
} from '@/components/library/book-meta';
import { Attribution } from '@/components/player/companion/companion-pieces';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { openExternalUrl } from '@/lib/support';
import { useThemeColors } from '@/theme/use-theme-colors';

import { aboutContent } from './book-details-model';

/**
 * The book page's About card (in the aside): the description (`aboutContent`, collapsed
 * past six lines; an undescribed book still reads complete), the production facts the
 * community or the server knows, and, beside community text, the server's attribution
 * line with "Improve this" (the work's page, opened in the browser). A matched book
 * without community text keeps the quiet "View on AudioSilo Meta" link. Nothing in it is
 * pink.
 */
export function BookAbout({ book, meta }: { book: Book; meta?: MatchedBookMeta }) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const [expanded, setExpanded] = useState(false);
  const { text, community, details } = aboutContent(book, meta, t);
  const canCollapse = descriptionIsLong(text);
  const attribution = community ? meta?.work.attribution : undefined;
  const improveUrl = attribution?.source_url || meta?.web_url;

  return (
    <Card className="gap-2.5">
      <Text variant="eyebrow">{t('book.meta.about')}</Text>
      <View className="gap-1">
        <Text
          className="text-[15px] leading-6 text-foreground"
          numberOfLines={expanded || !canCollapse ? undefined : 6}
        >
          {text}
        </Text>
        {canCollapse ? (
          <AnimatedPressable
            onPress={() => setExpanded((v) => !v)}
            hitSlop={8}
            accessibilityRole="button"
            className="flex-row items-center gap-1 self-start py-0.5"
          >
            <Text className="font-sans-semibold text-sm text-foreground">
              {expanded ? t('book.meta.showLess') : t('book.meta.showMore')}
            </Text>
            <DisclosureChevron open={expanded} quiet />
          </AnimatedPressable>
        ) : null}
      </View>
      {details.length > 0 ? (
        <View className="mt-1 gap-1.5">
          {details.map((d) => (
            <View key={d.label} className="flex-row gap-3">
              <Text variant="muted" className="w-28">
                {d.label}
              </Text>
              <Text variant="label" className="min-w-0 flex-1">
                {d.value}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
      {attribution ? (
        <View className="mt-1 gap-1">
          <Attribution attribution={attribution} />
          {improveUrl ? (
            <QuietLink
              label={t('book.about.improve')}
              color={themed.mutedForeground}
              onPress={() => void openExternalUrl(improveUrl)}
            />
          ) : null}
        </View>
      ) : meta ? (
        <QuietLink
          label={t('book.meta.viewOnMeta')}
          color={themed.mutedForeground}
          onPress={() => void openExternalUrl(meta.web_url)}
        />
      ) : null}
    </Card>
  );
}

/** An underlined link out of the app in muted text. */
function QuietLink({
  label,
  color,
  onPress,
}: {
  label: string;
  color: string;
  onPress: () => void;
}) {
  return (
    <AnimatedPressable
      onPress={onPress}
      accessibilityRole="link"
      hitSlop={8}
      className="flex-row items-center gap-1 self-start py-1"
    >
      <Text variant="caption" className="underline">
        {label}
      </Text>
      <Icon name="arrow-up-right" size={11} color={color} />
    </AnimatedPressable>
  );
}
