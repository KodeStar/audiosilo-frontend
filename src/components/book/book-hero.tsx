import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, Pressable, View } from 'react-native';

import type { Book } from '@/api/types';
import { BookCover } from '@/components/library/book-cover';
import { CoverWash } from '@/components/library/cover-wash';
import { RatingStars } from '@/components/player/rating-stars';
import { Badge } from '@/components/ui/badge';
import { Icon } from '@/components/ui/icon';
import { ProgressBar } from '@/components/ui/progress-bar';
import { FOCUS_RING_CLASS, Text } from '@/components/ui/text';
import { CONTENT_WIDTH } from '@/lib/layout';
import { bookTitle } from '@/lib/paths';
import { cn } from '@/lib/utils';
import { tabularNums } from '@/theme/tabular-nums';
import { useThemeColors } from '@/theme/use-theme-colors';

import type { BookPageLayout, Fact, TitleScale } from './book-page-model';
import { titleScale } from './book-page-model';
import { useBookRating } from './use-book-rating';

/** The title's display size per step (STYLEGUIDE section 4, Display XL: 52 desktop, 40
 * tablet, 30 phone; one step down for a long title). */
const TITLE_CLASS: Record<TitleScale, string> = {
  lg: 'text-[52px] leading-[54px]',
  md: 'text-[40px] leading-[43px]',
  sm: 'text-[30px] leading-[33px]',
  xs: 'text-[25px] leading-[29px]',
};

/** Where the listener is in a book in progress: the percent, "Chapter 23 of 81", the
 * time left at the book's own speed, and the fraction for the bar. */
export type HeroPlace = { percent: number; fraction: number; line: string; timeLeft: string };

export type BookHeroProps = {
  connectionId: string;
  libraryId: number;
  book: Book;
  layout: BookPageLayout;
  /** Above the hero (the folder crumbs). */
  crumbs?: ReactNode;
  eyebrow: { text: string; series?: string };
  facts: Fact[];
  /** In progress: the place line and bar. */
  place?: HeroPlace | null;
  /** Finished: the badge (with the finish date when known) and, with `ratings`, stars. */
  finished?: { date?: string } | null;
  ratings: boolean;
  onOpenSeries?: () => void;
  onOpenAuthor?: () => void;
  /** Absent: the narrator is plain text (a server without narrator pages). */
  onOpenNarrator?: () => void;
  /** The action row (primary, download, Up next, favourite, collection, more). */
  actions: ReactNode;
  /** Under the actions: the download's progress and the "converted for this browser"
   * note. */
  footer?: ReactNode;
};

/**
 * The book page's hero (the prototype's `Book()` hero): the cover washed into the
 * background from its `cover_color` (a neutral wash without one; text never sits on raw
 * cover colour), the eyebrow, the title in display type, the byline, the facts row, the
 * listener's place (the view's one pink thing, the progress bar) or the finished badge
 * and rating, then the actions. Cover beside the text on tablet and desktop, above it on
 * a phone.
 */
export function BookHero({
  connectionId,
  libraryId,
  book,
  layout,
  crumbs,
  eyebrow,
  facts,
  place,
  finished,
  ratings,
  onOpenSeries,
  onOpenAuthor,
  onOpenNarrator,
  actions,
  footer,
}: BookHeroProps) {
  const themed = useThemeColors();
  const title = bookTitle(book.title, book.rel_path);
  const wash = book.cover_color?.bg
    ? book.cover_color
    : { bg: themed.mutedForeground, accent: themed.mutedForeground };
  const cover = (
    <BookCover
      connectionId={connectionId}
      libraryId={libraryId}
      path={book.rel_path}
      coverVersion={book.cover_version}
      width={layout.cover}
      title={title}
      author={book.author}
      shadow="lg"
      className={layout.heroSide ? undefined : 'self-center'}
    />
  );
  return (
    <View testID="book-hero" className="relative overflow-hidden border-b border-border">
      <CoverWash color={wash} variant="hero" />
      <View
        className={cn(
          CONTENT_WIDTH,
          'self-center',
          layout.heroSide ? 'gap-5 px-6 pb-8 pt-5 lg:px-8' : 'gap-4 px-4 pb-6 pt-3',
        )}
      >
        {crumbs}
        <View
          className={cn(
            layout.heroSide
              ? cn('flex-row', layout.heroAlign === 'end' ? 'items-end' : 'items-start')
              : 'gap-5',
            layout.heroSide && (layout.cover >= 300 ? 'gap-10' : 'gap-7'),
          )}
        >
          {cover}
          <View className="min-w-0 flex-1 gap-3">
            <Eyebrow eyebrow={eyebrow} onOpenSeries={onOpenSeries} />
            <Text
              variant="display-xl"
              accessibilityRole="header"
              className={TITLE_CLASS[titleScale(layout.title, title)]}
            >
              {title}
            </Text>
            <Byline book={book} onOpenAuthor={onOpenAuthor} onOpenNarrator={onOpenNarrator} />
            <Facts facts={facts} />
            {place ? <Place place={place} /> : null}
            {finished ? (
              <Finished
                connectionId={connectionId}
                libraryId={libraryId}
                path={book.rel_path}
                date={finished.date}
                ratings={ratings}
              />
            ) : null}
            <View className="mt-2 gap-3">
              {actions}
              {footer}
            </View>
          </View>
        </View>
      </View>
    </View>
  );
}

/** A quiet link inside running text (the series eyebrow, a name in the byline). */
function TextLink({
  label,
  onPress,
  children,
}: {
  label: string;
  onPress: () => void;
  children: ReactNode;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="link"
      accessibilityLabel={label}
      hitSlop={8}
      className={cn(
        'rounded-sm active:opacity-70',
        Platform.select({ web: `cursor-pointer hover:underline ${FOCUS_RING_CLASS}` }),
      )}
    >
      {children}
    </Pressable>
  );
}

function Eyebrow({
  eyebrow,
  onOpenSeries,
}: {
  eyebrow: { text: string; series?: string };
  onOpenSeries?: () => void;
}) {
  const { t } = useTranslation();
  if (!eyebrow.text) return null;
  const text = <Text variant="eyebrow">{eyebrow.text}</Text>;
  if (!eyebrow.series || !onOpenSeries) return text;
  return (
    <View className="flex-row">
      <TextLink
        label={t('book.hero.openSeries', { series: eyebrow.series })}
        onPress={onOpenSeries}
      >
        {text}
      </TextLink>
    </View>
  );
}

/** "by <author> · read by <narrator>", each name opening its page. */
function Byline({
  book,
  onOpenAuthor,
  onOpenNarrator,
}: {
  book: Book;
  onOpenAuthor?: () => void;
  onOpenNarrator?: () => void;
}) {
  const { t } = useTranslation();
  const name = (value: string, onPress: (() => void) | undefined, label: string) => {
    const words = (
      <Text className="font-sans-semibold text-base text-foreground lg:text-[17px]">{value}</Text>
    );
    return onPress ? (
      <TextLink label={label} onPress={onPress}>
        {words}
      </TextLink>
    ) : (
      words
    );
  };
  const part = (word: string) => (
    <Text className="font-sans text-base text-muted-foreground lg:text-[17px]">{word}</Text>
  );
  if (!book.author && !book.narrator) return null;
  return (
    <View className="flex-row flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
      {book.author ? (
        <>
          {part(t('book.hero.by'))}
          {name(book.author, onOpenAuthor, t('book.hero.openAuthor', { name: book.author }))}
        </>
      ) : null}
      {book.author && book.narrator ? part('·') : null}
      {book.narrator ? (
        <>
          {part(t('book.hero.readBy'))}
          {name(
            book.narrator,
            onOpenNarrator,
            t('book.hero.openNarrator', { name: book.narrator }),
          )}
        </>
      ) : null}
    </View>
  );
}

function Facts({ facts }: { facts: Fact[] }) {
  const themed = useThemeColors();
  if (facts.length === 0) return null;
  return (
    <View className="flex-row flex-wrap gap-x-[18px] gap-y-1.5">
      {facts.map((f) => (
        <View key={f.key} className="flex-row items-center gap-1.5">
          <Icon name={f.icon} size={14} color={themed.mutedForeground} />
          <Text variant="muted" style={tabularNums}>
            {f.text}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** The place of a book in progress: "38% · Chapter 23 of 81", the time left at its speed,
 * and the bar. */
function Place({ place }: { place: HeroPlace }) {
  return (
    <View className="mt-2 max-w-[560px] gap-2">
      <View className="flex-row flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <Text className="text-[13px] text-muted-foreground" style={tabularNums}>
          <Text className="font-sans-bold text-[13px] text-foreground" style={tabularNums}>
            {`${place.percent}%`}
          </Text>
          {place.line ? ` · ${place.line}` : ''}
        </Text>
        {place.timeLeft ? (
          <Text className="text-[13px] text-muted-foreground" style={tabularNums}>
            {place.timeLeft}
          </Text>
        ) : null}
      </View>
      <ProgressBar fraction={place.fraction} minPercent={1} className="h-1.5" />
    </View>
  );
}

/** "Finished 3 Oct" and, where the server keeps ratings, the stars. */
function Finished({
  connectionId,
  libraryId,
  path,
  date,
  ratings,
}: {
  connectionId: string;
  libraryId: number;
  path: string;
  date?: string;
  ratings: boolean;
}) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  return (
    <View className="mt-1 flex-row flex-wrap items-center gap-x-3 gap-y-1">
      <Badge variant="success">
        <Icon name="check" size={12} color={themed.success} />
        <Text>{date ? t('book.hero.finishedOn', { date }) : t('book.hero.finished')}</Text>
      </Badge>
      {ratings ? (
        <HeroRating connectionId={connectionId} libraryId={libraryId} path={path} />
      ) : null}
    </View>
  );
}

function HeroRating({
  connectionId,
  libraryId,
  path,
}: {
  connectionId: string;
  libraryId: number;
  path: string;
}) {
  const rating = useBookRating(connectionId, libraryId, path);
  return (
    <RatingStars value={rating.value} onRate={rating.rate} disabled={!rating.ready} size={20} />
  );
}
