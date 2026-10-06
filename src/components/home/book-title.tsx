import { useTranslation } from 'react-i18next';

import { type SourcedProgress, useBook } from '@/api/hooks';
import { CoverTile } from '@/components/library/cover-tile';
import { formatDuration, formatRelative } from '@/lib/format';
import { bookTitle } from '@/lib/paths';
import { percentHeard } from '@/lib/progress-view';

import type { BookAt } from './home-model';
import { timeLeftAtSpeed } from './now-card-model';

/** A shelf's titles and covers barely change: a tile mounted again within this long
 * (Home, See all) shows what it has rather than asking again. */
const TILE_BOOK_STALE_MS = 10 * 60_000;

/**
 * A progress row carries only a path, so Home asks the book itself (`/item`, the book
 * page's own cache entry) for its title, falling back to the path's last part until it
 * answers or when it can't. Mounted per visible tile, so only the covers on screen ask.
 */
export function useProgressBook(at: BookAt | null) {
  return useBook(at?.libraryId ?? 0, at?.path ?? '', at?.connectionId, {
    staleTime: TILE_BOOK_STALE_MS,
  }).data;
}

/** The title of a book Home knows only by path ('' for none). */
export function useBookTitle(at: BookAt | null): string {
  const book = useProgressBook(at);
  return at ? bookTitle(book?.title, at.path) : '';
}

/** A Continue listening / Recently finished cover: progress along its foot and "40% ·
 * 1h 15m left" (at the book's own speed) or when it was finished. */
export function ProgressTile({
  item,
  width,
  server,
}: {
  item: SourcedProgress;
  width: number;
  server?: string;
}) {
  const { t } = useTranslation();
  const book = useProgressBook({
    connectionId: item.connectionId,
    libraryId: item.library_id,
    path: item.path,
  });
  const percent = percentHeard(item.position, item.duration, item.finished);
  const left = formatDuration(
    timeLeftAtSpeed(item.position, item.duration, item.playback_speed || 1),
  );
  const finishedWhen = formatRelative(item.finished_at ?? item.updated_at);
  const caption = item.finished
    ? finishedWhen
      ? t('home.finishedWhen', { when: finishedWhen })
      : t('covers.finished')
    : left
      ? t('home.progressCaption', { percent, left })
      : `${percent}%`;
  return (
    <CoverTile
      connectionId={item.connectionId}
      libraryId={item.library_id}
      path={item.path}
      title={bookTitle(book?.title, item.path)}
      author={book?.author}
      coverVersion={book?.cover_version}
      caption={caption}
      width={width}
      server={server}
      book={book}
      onShelf
    />
  );
}
