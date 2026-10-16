import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import type { Book, BookMetaWork } from '@/api/types';
import {
  descriptionIsLong,
  DisclosureChevron,
  GeneratedChip,
  type MatchedBookMeta,
} from '@/components/library/book-meta';
import { libraryBooksHref } from '@/components/library/books/books-view';
import { Attribution } from '@/components/player/companion/companion-pieces';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Card } from '@/components/ui/card';
import { chipClass } from '@/components/ui/filter-chip';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import type { LabelKind } from '@/lib/labels';
import { openLibraryRoot } from '@/lib/open';
import { openExternalUrl } from '@/lib/support';
import { cn } from '@/lib/utils';
import { useLibrarySelection } from '@/stores/library-selection';
import { useThemeColors } from '@/theme/use-theme-colors';

import { aboutContent, type LabelGroup } from './book-details-model';

const GROUP_KEY = {
  genre: 'book.about.genres',
  tag: 'book.about.tags',
} as const satisfies Record<LabelKind, string>;

const OPEN_KEY = {
  genre: 'book.about.openGenre',
  tag: 'book.about.openTag',
} as const satisfies Record<LabelKind, string>;

/**
 * The Library's Books mode on one genre or tag of the book's library (a chip's press):
 * that library becomes the browse modes' pick, since Books mode shows the selected one,
 * then the Library tab's root opens on the filter (`libraryBooksHref`).
 */
export function openLabelBooks(
  connectionId: string,
  libraryId: number,
  kind: LabelKind,
  name: string,
) {
  useLibrarySelection.getState().select({ connectionId, libraryId });
  openLibraryRoot(libraryBooksHref({ [kind]: name }));
}

/**
 * The book page's About card (in the aside): the description (`aboutContent`, collapsed
 * past six lines; an undescribed book still reads complete), the production facts the
 * community or the server knows, and, beside community text, the server's attribution
 * line with "Improve this" (the work's page, opened in the browser). A description a
 * Bridge generated on this server wears the "Generated on this server" chip under the
 * eyebrow and never the credit or "Improve this". A matched book without community text
 * keeps the quiet "View on AudioSilo Meta" link. Then the book's genres and tags as
 * chips under their names, each opening the Library on it (`onOpenLabel`). Nothing in it
 * is pink.
 */
export function BookAbout({
  book,
  meta,
  work,
  onOpenLabel,
}: {
  book: Book;
  /** The matched envelope (`matchedMeta`): the recording's facts and the link to
   * AudioSilo Meta need a real community match. */
  meta?: MatchedBookMeta;
  /** The work every work-level field comes from (`bookMetaWork`): the matched work, or an
   * unmatched book's generated one. Required, with no fallback to `meta`'s work: a host
   * that left it out would drop an unmatched book's generated description, and a default
   * here made the React Compiler skip this component. */
  work: BookMetaWork | undefined;
  onOpenLabel: (kind: LabelKind, name: string) => void;
}) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const [expanded, setExpanded] = useState(false);
  const { text, source, details, labels } = aboutContent(book, work, meta?.recording, t);
  const canCollapse = descriptionIsLong(text);
  // The credit comes from the same work as the text it credits.
  const attribution = source === 'community' ? work?.attribution : undefined;
  const improveUrl = attribution?.source_url || meta?.web_url;

  return (
    <Card className="gap-2.5">
      <Text variant="eyebrow">{t('book.meta.about')}</Text>
      {source === 'generated' ? <GeneratedChip testID="about-generated-mark" /> : null}
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
      {labels.length > 0 ? (
        <View className="mt-1 gap-2.5">
          {labels.map((g) => (
            <Labels key={g.kind} group={g} onOpen={onOpenLabel} />
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

/** One kind of label under its name ("Genres"): a wrapping row of chips. */
function Labels({
  group,
  onOpen,
}: {
  group: LabelGroup;
  onOpen: (kind: LabelKind, name: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <View className="gap-1.5" role="group" accessibilityLabel={t(GROUP_KEY[group.kind])}>
      <Text variant="muted">{t(GROUP_KEY[group.kind])}</Text>
      <View className="flex-row flex-wrap gap-2">
        {group.names.map((name) => (
          <LabelChip
            key={name}
            name={name}
            label={t(OPEN_KEY[group.kind], { name })}
            onPress={() => onOpen(group.kind, name)}
          />
        ))}
      </View>
    </View>
  );
}

/** A genre or tag as a pill (`chipClass`, unselected), opening the Library on it. */
function LabelChip({
  name,
  label,
  onPress,
}: {
  name: string;
  /** What a press does, for a screen reader ("Books in the genre Fantasy"). */
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="link"
      accessibilityLabel={label}
      hitSlop={{ top: 6, bottom: 6 }}
      className={cn(chipClass(), 'max-w-full')}
    >
      <Text className="font-sans-semibold text-[13px] text-foreground" numberOfLines={1}>
        {name}
      </Text>
    </Pressable>
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
