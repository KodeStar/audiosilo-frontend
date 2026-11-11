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
import { Icon } from '@/components/ui/icon';
import { PressableRow } from '@/components/ui/row-surface';
import { RowSkeletonList } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useDeviceOnline } from '@/lib/device-online';
import { offlineState, type UnreadState } from '@/lib/offline-state';
import { useOpen } from '@/lib/open';
import { useThemeColors } from '@/theme/use-theme-colors';

import { LoadError } from '../books/book-states';
import { GlyphTile } from '../glyph-tile';
import { NoLibrariesState } from '../no-libraries-state';
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
  const themed = useThemeColors();
  // A server whose sign-in ended shows the sign-in state, not a load error or "no
  // libraries" (frontend#124).
  const signedOut = useSignedOutConnections();
  const refused = refusedConnection(signedOut, lists);
  const deviceOnline = useDeviceOnline();
  // What to say of a server whose list is not in (`offlineState`): `failed` names the
  // server under its heading with a Retry of its own (CONNECT-06); `offline` (no network
  // on the device, so a Retry cannot work) says its libraries show once it answers.
  // A signed-out server's failed list is the sign-in state above, whatever the network.
  const unread = (g: LibrariesOfServer): UnreadState =>
    g.status === 'error' && signedOut.some((c) => c.id === g.connectionId)
      ? null
      : offlineState({ waiting: g.paused, failed: g.status === 'error', deviceOnline });
  const rows = lists.map((g) => ({ g, state: unread(g) }));
  const anyOffline = rows.some((r) => r.state === 'offline');
  const anyFailed = rows.some((r) => r.state === 'failed');
  // With no library to list, offline is the page's own state (below), not a row per server.
  // Not beside a sign-in state, which takes the page state's place: the offline servers
  // keep their rows then.
  const offlinePage = libraries.length === 0 && anyOffline && !anyFailed && !refused;

  // One group per server (in connection order) that has libraries or whose list is not in,
  // each under its server's heading when there are several (a signed-out server's list
  // still cached included, so no two servers' libraries ever read as one). A server the
  // device is offline for is listed too, with a line saying so: it is not dropped without
  // a word while another server's cached libraries show (fe#179).
  const groups = rows.filter(
    ({ g, state }) => g.libraries.length > 0 || (!offlinePage && state !== null),
  );
  const showServerHeaders = groups.length > 1;

  return (
    <TabPageScroll contentContainerClassName="gap-0">
      {isLoading ? <RowSkeletonList /> : null}
      {refused ? <SignInAgainState connection={refused} className="mb-2" /> : null}
      <FavouritesShelfRow />

      {groups.map(({ g, state }) => (
        <View key={g.connectionId}>
          {showServerHeaders ? (
            <Text variant="eyebrow" className="mb-1 mt-4">
              {g.connectionName}
            </Text>
          ) : null}
          {state === 'failed' ? (
            <View className="my-1">
              <LoadError
                compact
                title={t('library.list.loadServerLibrariesError', { name: g.connectionName })}
                retryLabel={t('common.retry')}
                onRetry={() => retryServer(g.connectionId)}
              />
            </View>
          ) : null}
          {state === 'offline' ? (
            <View
              testID={`folders-offline-${g.connectionId}`}
              className="my-1 flex-row items-center gap-3 rounded-xl border border-border bg-card px-3 py-2"
            >
              <Icon name="offline" size={16} color={themed.mutedForeground} />
              <View className="flex-1">
                <Text variant="label">{t('common.offlineTitle')}</Text>
                <Text variant="caption">
                  {t('library.list.serverOffline', { name: g.connectionName })}
                </Text>
              </View>
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
      {libraries.length === 0 && !isLoading && !refused && !anyFailed ? (
        <NoLibrariesState offline={offlinePage} connectionIds={lists.map((g) => g.connectionId)} />
      ) : null}
    </TabPageScroll>
  );
}
