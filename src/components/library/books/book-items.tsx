import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import type { Book, Progress } from '@/api/types';
import { Icon } from '@/components/ui/icon';
import { ProgressBar } from '@/components/ui/progress-bar';
import { Text } from '@/components/ui/text';
import { bookSubtitle, formatDuration, formatRelative } from '@/lib/format';
import { useOpen } from '@/lib/open';
import { bookTitle } from '@/lib/paths';
import { percentHeard, percentOf, progressFractionRemaining } from '@/lib/progress-view';
import { tabularNums } from '@/theme/tabular-nums';
import { useThemeColors } from '@/theme/use-theme-colors';

import { CoverListRow } from '../cover-grid';
import { CoverTile } from '../cover-tile';
import { type BookAction, BookActionsButton } from './book-actions';
import { bookStatus, type BooksSort } from './books-view';
import type { ListColumns } from './list-columns';

/** A book's shown title (its folder's name when it has none). */

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

/** A book of the listener's library as a cover tile (which marks its own progress). */
export function BookTile({
  connectionId,
  libraryId,
  book,
  sort,
  width,
}: {
  connectionId: string;
  libraryId: number;
  book: Book;
  sort?: BooksSort;
  width: number;
}) {
  return (
    <CoverTile
      connectionId={connectionId}
      libraryId={libraryId}
      path={book.rel_path}
      book={book}
      title={bookTitle(book.title, book.rel_path)}
      author={book.author}
      caption={tileCaption(book, sort)}
      coverVersion={book.cover_version}
      width={width}
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
      <ProgressBar fraction={fraction} />
      <Text variant="caption" numberOfLines={1} style={tabularNums}>
        {t('library.books.progress', {
          percent: percentOf(fraction),
          left: formatDuration(remaining),
        })}
      </Text>
    </View>
  );
}

/** Column widths of the list view (`some` drops Length). */
const COL = { narrator: 'w-[24%]', length: 'w-[76px]', progress: 'w-[140px]' };

/** The list view's column labels (none when the rows have no columns). */
export function BookListHeader({ columns }: { columns: ListColumns }) {
  const { t } = useTranslation();
  if (columns === 'none') return null;
  // Mirrors a row (CoverListRow): the card (a 1px border, the press's px-2 with the cover
  // then the text, and the actions button inside its pr-1), so the labels sit over their
  // columns.
  return (
    <View
      className="border-b border-border pb-2 pt-1"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <View className="flex-row items-center border border-transparent pr-1">
        <View className="flex-1 flex-row items-center gap-3 px-2">
          <View className="w-12" />
          <Text variant="caption" className="flex-1 font-sans-semibold">
            {t('library.books.columns.title')}
          </Text>
          <Text variant="caption" className={`${COL.narrator} font-sans-semibold`}>
            {t('library.books.columns.narrator')}
          </Text>
          {columns === 'all' ? (
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
    </View>
  );
}

/**
 * A book as a list row: cover, title, author · series; the `columns` the list has room
 * for (narrator, length, progress; without them the subtitle carries the length and the
 * state); then its actions button.
 */
export function BookListRow({
  connectionId,
  libraryId,
  book,
  progress,
  extra,
  columns,
}: {
  connectionId: string;
  libraryId: number;
  book: Book;
  progress?: Progress;
  extra?: BookAction[];
  columns: ListColumns;
}) {
  const { t } = useTranslation();
  const { openBook } = useOpen();
  const title = bookTitle(book.title, book.rel_path);
  const byline = bookSubtitle({
    author: book.author,
    series: book.series,
    seriesIndex: book.series_index,
  });
  const status = bookStatus(progress);
  // Without columns the subtitle carries the length and the state.
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
      subtitle={columns === 'none' ? phoneLine : byline}
      onPress={() => openBook(connectionId, libraryId, book.rel_path)}
      aside={
        columns === 'none' ? null : (
          <>
            <Text variant="caption" numberOfLines={1} className={COL.narrator}>
              {book.narrator}
            </Text>
            {columns === 'all' ? (
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
