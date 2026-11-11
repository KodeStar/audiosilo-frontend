import { router } from 'expo-router';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import {
  useAllProgressAll,
  useRecentAll,
  type MergedBook,
  type SourcedProgress,
} from '@/api/hooks';
import { useProgressBook } from '@/components/home/book-title';
import { OfflineState } from '@/components/layout/offline-state';
import { EmptyState } from '@/components/ui/empty-state';
import { GhostCovers } from '@/components/ui/ghost-art';
import { SegmentedControl } from '@/components/ui/toggle-group';
import { contentKey } from '@/lib/content-key';
import { formatRelative } from '@/lib/format';
import { useUnreadQuery } from '@/lib/offline-state';
import { bookTitle } from '@/lib/paths';
import { useRouteParams } from '@/lib/route-params';
import { usePageTitle } from '@/lib/use-page-title';
import { useMinuteClock } from '@/lib/use-now';

import { CoverGrid, CoverGridSkeleton } from '../cover-grid';
import { CoverTile, useServerFlag } from '../cover-tile';
import { BookTile } from './book-items';

// How many recently added books to load per server (the Home shelf shows 15).
const PAGE_LIMIT = 200;

type SeeAllType = 'recent' | 'finished';

/**
 * Home's "See all" for Recently added and Recently finished (`/browse?type=`), across
 * every server, as one cover grid. The type is the URL param, so a fresh "See all" tap
 * switches the list without mirrored state.
 */
export function SeeAllScreen() {
  const { t } = useTranslation();
  const params = useRouteParams<{ type?: string }>();
  const type: SeeAllType = params.type === 'finished' ? 'finished' : 'recent';
  usePageTitle(
    t(type === 'recent' ? 'library.list.recentlyAdded' : 'library.list.recentlyFinished'),
  );
  const serverOf = useServerFlag();

  const recent = useRecentAll(PAGE_LIMIT);
  const progress = useAllProgressAll();
  const finished = useMemo(
    () =>
      progress.progress
        .filter((p) => p.finished)
        .sort((a, b) =>
          (b.finished_at ?? b.updated_at).localeCompare(a.finished_at ?? a.updated_at),
        ),
    [progress.progress],
  );
  const state = type === 'recent' ? recent : progress;
  // With nothing in, a server's list held for the network (or failed without one) is not
  // "no books": every list read with nothing in them is (`useUnreadQuery`). Finished
  // books are judged by the progress list they come from (read, with none finished, is
  // an answer).
  const rows = type === 'recent' ? recent.books : progress.progress;
  const unread = useUnreadQuery({
    data: rows.length > 0 ? rows : undefined,
    isPaused: state.offline,
    error: state.error,
  });

  const header = (
    <View className="pb-5 pt-2">
      <SegmentedControl
        options={[
          { value: 'recent', label: t('library.list.recentlyAdded') },
          { value: 'finished', label: t('library.list.recentlyFinished') },
        ]}
        value={type}
        onChange={(next) => router.setParams({ type: next })}
        accessibilityLabel={t('library.list.viewLabel')}
        className="self-start"
      />
    </View>
  );

  const empty = state.isLoading ? (
    <CoverGridSkeleton rows={2} gutter={0} />
  ) : unread === 'offline' ? (
    <OfflineState variant="card" hint={t('common.offlineList')} />
  ) : (
    <EmptyState
      variant="card"
      art={<GhostCovers />}
      title={
        state.error
          ? t('library.list.loadError')
          : t(type === 'recent' ? 'library.list.noBooks' : 'library.list.noFinished')
      }
      hint={
        state.error
          ? undefined
          : t(type === 'recent' ? 'library.list.noBooksHint' : 'library.list.noFinishedHint')
      }
    />
  );

  const common = {
    ListHeaderComponent: header,
    ListEmptyComponent: empty,
  };

  return type === 'recent' ? (
    <CoverGrid
      key="recent"
      data={recent.books}
      keyExtractor={(b: MergedBook) => contentKey(b.connectionId, b.library_id, b.rel_path)}
      renderItem={(b, tile) => (
        <BookTile
          connectionId={b.connectionId}
          libraryId={b.library_id}
          book={b}
          sort="recent"
          server={serverOf(b.connectionId)}
          width={tile}
        />
      )}
      {...common}
    />
  ) : (
    <CoverGrid
      key="finished"
      data={finished}
      keyExtractor={(p: SourcedProgress) => contentKey(p.connectionId, p.library_id, p.path)}
      renderItem={(p, tile) => (
        <FinishedTile progress={p} server={serverOf(p.connectionId)} width={tile} />
      )}
      {...common}
    />
  );
}

/** A finished book: progress rows carry no title, so the tile reads its book (cached
 * with the book page; a grid only mounts the tiles it shows), the folder name until then. */
function FinishedTile({
  progress: p,
  server,
  width,
}: {
  progress: SourcedProgress;
  server?: string;
  width: number;
}) {
  const { t, i18n } = useTranslation();
  // Said in the current language and minute, as a book tile's "added" words (fe#162).
  const now = useMinuteClock();
  const book = useProgressBook({
    connectionId: p.connectionId,
    libraryId: p.library_id,
    path: p.path,
  });
  return (
    <CoverTile
      connectionId={p.connectionId}
      libraryId={p.library_id}
      path={p.path}
      title={bookTitle(book?.title, p.path)}
      book={book}
      author={book?.author}
      coverVersion={book?.cover_version}
      caption={t('library.books.finishedWhen', {
        when: formatRelative(p.finished_at ?? p.updated_at, i18n.language || 'en', now),
      })}
      finished
      server={server}
      width={width}
    />
  );
}
