import { router, useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import {
  useAllProgressAll,
  useBook,
  useRecentAll,
  type MergedBook,
  type SourcedProgress,
} from '@/api/hooks';
import { SegmentedControl } from '@/components/ui/toggle-group';
import { contentKey } from '@/lib/content-key';
import { formatRelative } from '@/lib/format';
import { pathLeaf } from '@/lib/paths';
import { useSession } from '@/stores/session';

import { CoverGrid, CoverGridSkeleton } from '../cover-grid';
import { CoverTile } from '../cover-tile';
import { titleOf, tileCaption } from './book-items';
import { GhostCovers, StateNotice } from './book-states';

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
  const params = useLocalSearchParams<{ type?: string }>();
  const type: SeeAllType = params.type === 'finished' ? 'finished' : 'recent';
  const defaultCid = useSession((s) => s.defaultConnectionId);
  const multi = useSession((s) => s.connections.length > 1);
  const serverOf = (cid: string, name: string) => (multi && cid !== defaultCid ? name : undefined);

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
  ) : (
    <StateNotice
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
        <CoverTile
          connectionId={b.connectionId}
          libraryId={b.library_id}
          path={b.rel_path}
          title={titleOf(b)}
          book={b}
          author={b.author}
          caption={tileCaption(b, 'recent')}
          coverVersion={b.cover_version}
          server={serverOf(b.connectionId, b.connectionName)}
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
        <FinishedTile
          progress={p}
          server={serverOf(p.connectionId, p.connectionName)}
          width={tile}
        />
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
  const { t } = useTranslation();
  const book = useBook(p.library_id, p.path, p.connectionId).data;
  return (
    <CoverTile
      connectionId={p.connectionId}
      libraryId={p.library_id}
      path={p.path}
      title={book ? titleOf(book) : pathLeaf(p.path)}
      book={book}
      author={book?.author}
      coverVersion={book?.cover_version}
      caption={t('library.books.finishedWhen', {
        when: formatRelative(p.finished_at ?? p.updated_at),
      })}
      finished
      server={server}
      width={width}
    />
  );
}
