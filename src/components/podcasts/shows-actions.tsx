import { useIsFocused } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';

import { useCapability, useFollowRequests } from '@/api/hooks';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Text } from '@/components/ui/text';
import { isKidAccount } from '@/lib/account';
import { useOpen } from '@/lib/open';
import { isOpenRequest } from '@/lib/podcast-requests';
import { useSession } from '@/stores/session';

import { useExportShows } from './opml-export';

/** Whether the listener may add shows on this connection: every way in ends in a follow,
 * which is the module's (`podcasts`: on, with its Bridge online), never for a kid's
 * account or the demo. `unknown` while `/server` is not known. */
export type AddShowsAccess = 'allowed' | 'kid' | 'demo' | 'unavailable' | 'unknown';

export function useAddShowsAccess(connectionId: string): AddShowsAccess {
  const can = useCapability('podcasts', connectionId);
  const user = useSession((s) => s.connections.find((c) => c.id === connectionId)?.user);
  if (isKidAccount(user)) return 'kid';
  if (user?.is_demo) return 'demo';
  if (can === undefined) return 'unknown';
  return can ? 'allowed' : 'unavailable';
}

/**
 * The Shows mode's actions (Bridge Phase 2d-2): Add shows (Find shows, for a listener who
 * may add), and a menu with Export my shows (capability `podcast_opml`, not the demo; it
 * works with the module off, so it is not on the Find shows page). Rendered in the
 * sub-nav row on tablet and desktop (`SubNavActions`), so it takes its connection as a
 * prop and reads no screen context. Nothing when neither applies.
 */
export function ShowsActions({
  connectionId,
  libraryId,
}: {
  connectionId: string;
  libraryId: number;
}) {
  const { t } = useTranslation();
  const { openFindShows } = useOpen();
  const access = useAddShowsAccess(connectionId);
  const opml = useCapability('podcast_opml', connectionId) === true;
  const demo = useSession(
    (s) => s.connections.find((c) => c.id === connectionId)?.user?.is_demo === true,
  );
  const exporter = useExportShows(connectionId);
  const canExport = opml && !demo;
  if (access !== 'allowed' && !canExport) return null;
  return (
    <View testID="shows-actions" className="flex-row items-center gap-2">
      {access === 'allowed' ? (
        <Button
          size="sm"
          icon="plus"
          title={t('podcasts.shows.addShows')}
          onPress={() => openFindShows(connectionId, libraryId)}
          testID="shows-add"
        />
      ) : null}
      {canExport ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              icon="ellipsis"
              loading={exporter.busy}
              accessibilityLabel={t('podcasts.shows.actionsMenu')}
              testID="shows-menu"
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              icon={Platform.OS === 'web' ? 'download' : 'share'}
              onPress={() => void exporter.run()}
              testID="shows-export"
            >
              <Text>{t('podcasts.export.action')}</Text>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </View>
  );
}

/**
 * One line in the Shows mode while shows are being added to this library ("Adding 2
 * shows"), opening Find shows. It polls the requests only while one is open and the
 * Library is focused (`useFollowRequests`). Nothing otherwise.
 */
export function FollowRequestsNotice({
  connectionId,
  libraryId,
}: {
  connectionId: string;
  libraryId: number;
}) {
  const { t } = useTranslation();
  const { openFindShows } = useOpen();
  const focused = useIsFocused();
  const { data } = useFollowRequests(libraryId, { active: focused }, connectionId);
  const open = data?.filter(isOpenRequest).length ?? 0;
  if (open === 0) return null;
  return (
    <Button
      variant="link"
      size="sm"
      icon="clock"
      title={t('podcasts.requests.notice', { count: open })}
      onPress={() => openFindShows(connectionId, libraryId)}
      className="self-start"
      testID="shows-requests-notice"
    />
  );
}
