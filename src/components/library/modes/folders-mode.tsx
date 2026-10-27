import { Link } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { type LibrariesOfServer, useFavouritesAll, useLibrariesAll } from '@/api/hooks';
import {
  refusedConnection,
  SignInAgainState,
  useSignedOutConnections,
} from '@/components/layout/sign-in-again';
import { TabPageScroll } from '@/components/shell/tab-page-scroll';
import { EmptyState } from '@/components/ui/empty-state';
import { Icon } from '@/components/ui/icon';
import { PressableRow } from '@/components/ui/row-surface';
import { RowSkeletonList } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useOpen } from '@/lib/open';

import { LoadError } from '../books/book-states';
import { GlyphTile } from '../glyph-tile';
// The quiet row's layout (the surface itself is PressableRow's).
const ROW = 'my-1 w-full flex-row items-center gap-3 px-3 py-2.5';

/** Favourites sits alongside the libraries as a special "shelf": a row that opens
 * the dedicated Favourites screen. Always shown so it stays discoverable. */
function FavouritesShelfRow() {
  const { t } = useTranslation();
  const { favourites } = useFavouritesAll();
  const count = favourites.length;
  return (
    <Link href="/library/favourites" asChild>
      <PressableRow accessibilityRole="link" className={ROW}>
        <GlyphTile icon="heart-solid" />
        <View className="flex-1">
          <Text variant="label">{t('library.favourites.title')}</Text>
          <Text variant="muted">
            {count === 0
              ? t('library.favourites.emptyHint')
              : t('library.favourites.itemCount', { count })}
          </Text>
        </View>
        <Icon name="chevron-right" size={16} />
      </PressableRow>
    </Link>
  );
}

/**
 * The Library tab's Folders mode: today's libraries-then-folders flow - Favourites, then
 * every server's libraries (grouped by server when there are several), each opening its
 * folder browser (`/library/[libraryId]`, breadcrumbs, filter, jump rail and scroll
 * memory). Unlike the other modes it spans every library, not the selected one.
 */
export function FoldersMode() {
  const { t } = useTranslation();
  const { libraries, groups: lists, isLoading, retryServer } = useLibrariesAll();
  const { openLibrary } = useOpen();
  // A server whose sign-in ended shows the sign-in state, not a load error or "no
  // libraries" (frontend#124); a list that failed otherwise says which server's it is,
  // under that server's heading, with a Retry of its own (CONNECT-06).
  const signedOut = useSignedOutConnections();
  const refused = refusedConnection(signedOut, lists);
  const failed = (g: LibrariesOfServer) =>
    g.status === 'error' && !signedOut.some((c) => c.id === g.connectionId);
  const error = lists.some(failed);
  const offline = lists.some((g) => g.paused);

  // One group per server (in connection order) that has libraries or failed to list them,
  // each under its server's heading when there are several (a signed-out server's list
  // still cached included, so no two servers' libraries ever read as one).
  const groups = lists.filter((g) => g.libraries.length > 0 || failed(g));
  const showServerHeaders = groups.length > 1;

  return (
    <TabPageScroll contentContainerClassName="gap-0">
      {isLoading ? <RowSkeletonList /> : null}
      {refused ? <SignInAgainState connection={refused} className="mb-2" /> : null}
      <FavouritesShelfRow />

      {groups.map((g) => (
        <View key={g.connectionId}>
          {showServerHeaders ? (
            <Text variant="eyebrow" className="mb-1 mt-4">
              {g.connectionName}
            </Text>
          ) : null}
          {failed(g) ? (
            <View className="my-1">
              <LoadError
                compact
                title={t('library.list.loadServerLibrariesError', { name: g.connectionName })}
                retryLabel={t('common.retry')}
                onRetry={() => retryServer(g.connectionId)}
              />
            </View>
          ) : null}
          {g.libraries.map((lib) => (
            <PressableRow
              key={`${g.connectionId}:${lib.id}`}
              onPress={() => void openLibrary(g.connectionId, lib.id)}
              accessibilityRole="button"
              className={ROW}
            >
              <GlyphTile icon="folder" />
              <View className="flex-1">
                <Text variant="label">{lib.name}</Text>
                <Text variant="muted">{lib.default_view}</Text>
              </View>
              <Icon name="chevron-right" size={16} />
            </PressableRow>
          ))}
        </View>
      ))}

      {/* A server that did not answer has not said it shares nothing (frontend#131), nor
          has one the device went offline waiting for (its list is paused). */}
      {libraries.length === 0 && !isLoading && !refused && !error ? (
        offline ? (
          <EmptyState
            icon="offline"
            title={t('library.list.offlineTitle')}
            hint={t('library.list.offlineHint')}
          />
        ) : (
          <EmptyState
            icon="library"
            title={t('library.list.noLibraries')}
            hint={t('library.list.noLibrariesHint')}
          />
        )
      ) : null}
    </TabPageScroll>
  );
}
