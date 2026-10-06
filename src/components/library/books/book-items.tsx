import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import type { Book, Progress } from '@/api/types';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { bookSubtitle, formatDuration, formatRelative } from '@/lib/format';
import { useLayout } from '@/lib/layout';
import { useOpen } from '@/lib/open';
import { pathLeaf } from '@/lib/paths';
import { percentHeard, percentOf, progressFractionRemaining } from '@/lib/progress-view';
import { tabularNums } from '@/theme/tabular-nums';
import { useThemeColors } from '@/theme/use-theme-colors';

import { CoverListRow } from '../cover-grid';
import { CoverTile } from '../cover-tile';
import { type BookAction, BookActionsButton } from './book-actions';
import { bookStatus, type BooksSort } from './books-view';

/** A book's shown title (its folder's name when it has none). */
export const titleOf = (b: Book) => b.title || pathLeaf(b.rel_path);

/** The line under a tile's title, by the list's order: when it was added (Recently
 * added), its length (Length), else its author. */
export function tileCaption(b: Book, sort: BooksSort | undefined): string {
  const extra =
    sort === 'recent'
      ? formatRelative(b.added_at)
      : sort === 'length'
        ? formatDuration(b.duration)
        : '';
  return [b.author, extra].filter(Boolean).join(' · ');
}

/** A book of the listener's library as a cover tile, with its progress. */
export function BookTile({
  connectionId,
  libraryId,
  book,
  progress,
  sort,
  width,
}: {
  connectionId: string;
  libraryId: number;
  book: Book;
  progress?: Progress;
  sort?: BooksSort;
  width: number;
}) {
  const status = bookStatus(progress);
  return (
    <CoverTile
      connectionId={connectionId}
      libraryId={libraryId}
      path={book.rel_path}
      book={book}
      title={titleOf(book)}
      author={book.author}
      caption={tileCaption(book, sort)}
      coverVersion={book.cover_version}
      width={width}
      finished={status === 'finished'}
      progress={
        status === 'progress'
          ? progressFractionRemaining(progress!.position, book.duration).fraction
          : undefined
      }
    />
  );
}

/** "Finished" / a progress bar with "40% · 3h 12m left" / "Not started". */
function ProgressCell({ book, progress }: { book: Book; progress?: Progress }) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const status = bookStatus(progress);
  if (status === 'finished') {
    return (
      <View className="flex-row items-center gap-1.5">
        <Icon name="circle-check" size={14} color={themed.success} />
        <Text variant="caption" className="text-success">
          {t('covers.finished')}
        </Text>
      </View>
    );
  }
  if (status === 'new') {
    return (
      <Text variant="caption" className="text-subtle-foreground">
        {t('library.books.filters.new')}
      </Text>
    );
  }
  const { fraction, remaining } = progressFractionRemaining(progress!.position, book.duration);
  return (
    <View className="gap-1">
      <View className="h-1 overflow-hidden rounded-full bg-muted">
        <View className="h-full rounded-full bg-brand" style={{ width: `${fraction * 100}%` }} />
      </View>
      <Text variant="caption" numberOfLines={1} style={tabularNums}>
        {t('library.books.progress', {
          percent: percentOf(fraction),
          left: formatDuration(remaining),
        })}
      </Text>
    </View>
  );
}

/** Column widths of the list view (tablet drops Length). */
const COL = { narrator: 'w-[24%]', length: 'w-[76px]', progress: 'w-[140px]' };

/** The list view's column labels (tablet and desktop). */
export function BookListHeader() {
  const { t } = useTranslation();
  const desktop = useLayout() === 'desktop';
  // Mirrors a row: the pressable card (bordered, px-2, cover then text) and the
  // actions button beside it, so the labels sit over their columns.
  return (
    <View
      className="flex-row items-center gap-2 border-b border-border pb-2 pt-1"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <View className="flex-1 flex-row items-center gap-3 border border-transparent px-2">
        <View className="w-12" />
        <Text variant="caption" className="flex-1 font-sans-semibold">
          {t('library.books.columns.title')}
        </Text>
        <Text variant="caption" className={`${COL.narrator} font-sans-semibold`}>
          {t('library.books.columns.narrator')}
        </Text>
        {desktop ? (
          <Text variant="caption" className={`${COL.length} font-sans-semibold`}>
            {t('library.books.columns.length')}
          </Text>
        ) : null}
        <Text variant="caption" className={`${COL.progress} font-sans-semibold`}>
          {t('library.books.columns.progress')}
        </Text>
      </View>
      <View className="w-[38px]" />
    </View>
  );
}

/**
 * A book as a list row: cover, title, author · series; on tablet and desktop the
 * narrator, length (desktop) and progress columns; then its actions button.
 */
export function BookListRow({
  connectionId,
  libraryId,
  book,
  progress,
  extra,
}: {
  connectionId: string;
  libraryId: number;
  book: Book;
  progress?: Progress;
  extra?: BookAction[];
}) {
  const { t } = useTranslation();
  const layout = useLayout();
  const { openBook } = useOpen();
  const title = titleOf(book);
  const byline = bookSubtitle({
    author: book.author,
    series: book.series,
    seriesIndex: book.series_index,
  });
  const status = bookStatus(progress);
  // A phone has no columns: its subtitle carries the length and the state.
  const phoneLine = [
    byline,
    formatDuration(book.duration),
    status === 'finished'
      ? t('covers.finished')
      : status === 'progress'
        ? t('covers.listened', {
            percent: percentHeard(progress!.position, book.duration, false),
          })
        : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <CoverListRow
      connectionId={connectionId}
      libraryId={libraryId}
      path={book.rel_path}
      title={title}
      author={book.author}
      coverVersion={book.cover_version}
      subtitle={layout === 'phone' ? phoneLine : byline}
      onPress={() => openBook(connectionId, libraryId, book.rel_path)}
      aside={
        layout === 'phone' ? null : (
          <>
            <Text variant="caption" numberOfLines={1} className={COL.narrator}>
              {book.narrator}
            </Text>
            {layout === 'desktop' ? (
              <Text variant="caption" className={COL.length} style={tabularNums}>
                {formatDuration(book.duration)}
              </Text>
            ) : null}
            <View className={COL.progress}>
              <ProgressCell book={book} progress={progress} />
            </View>
          </>
        )
      }
      trailing={
        <BookActionsButton
          connectionId={connectionId}
          libraryId={libraryId}
          book={book}
          progress={progress}
          extra={extra}
        />
      }
    />
  );
}
