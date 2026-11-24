import { useIsFocused } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import {
  CapabilityError,
  useCapability,
  useDismissPodcastRequest,
  useFollowRequests,
  usePodcastShows,
} from '@/api/hooks';
import type { PodcastRequest, PodcastShow } from '@/api/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { RowSurface } from '@/components/ui/row-surface';
import { SectionTitle } from '@/components/ui/section-title';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { useOpen } from '@/lib/open';
import { isOpenRequest, requestShow } from '@/lib/podcast-requests';
import { useThemeColors } from '@/theme/use-theme-colors';

import { requestLabel, requestStateKey } from './find-shows-model';
import { requestReasonKey } from './podcast-model';

/** The ended requests a list keeps under the open ones (the server lists a week's). */
const ENDED_SHOWN = 10;

/**
 * A podcast library's follow requests on the Find shows page (Bridge Phase 2d-2): the
 * shows being added (open first), then the ones that ended, newest first, each by the
 * show's name where it is known (`requestLabel`, fe#126) with its state in words, why it
 * could not be added, Open show once it is in the library, and Dismiss on one that failed
 * or was cancelled (capability `podcast_request_dismiss`). It polls only while one is open
 * and its screen is focused (`useFollowRequests`). Nothing when there are none.
 */
export function FollowRequests({
  connectionId,
  libraryId,
}: {
  connectionId: string;
  libraryId: number;
}) {
  const { t } = useTranslation();
  const focused = useIsFocused();
  const { data } = useFollowRequests(libraryId, { active: focused }, connectionId);
  // An added show's row reads its name from the library's show list.
  const { data: shows } = usePodcastShows(libraryId, connectionId);
  const canDismiss = useCapability('podcast_request_dismiss', connectionId) === true;
  const dismiss = useDismissPodcastRequest(connectionId);
  if (!data?.length) return null;
  // `data` is open first: every open one, then the newest ended ones.
  const shown = data.slice(0, data.filter(isOpenRequest).length + ENDED_SHOWN);
  const onDismiss = canDismiss
    ? (r: PodcastRequest) =>
        dismiss.mutateAsync({ id: r.id }).catch((e: unknown) => {
          if (!(e instanceof CapabilityError))
            toast({ title: t('podcasts.requests.dismissFailed') });
        })
    : undefined;
  return (
    <View testID="follow-requests" className="gap-2 pt-6">
      <SectionTitle title={t('podcasts.requests.title')} small />
      {shown.map((r) => (
        <RequestRow
          key={r.id}
          connectionId={connectionId}
          request={r}
          shows={shows}
          onDismiss={onDismiss}
          dismissing={dismiss.isPending && dismiss.variables?.id === r.id}
        />
      ))}
    </View>
  );
}

function RequestRow({
  connectionId,
  request,
  shows,
  onDismiss,
  dismissing,
}: {
  connectionId: string;
  request: PodcastRequest;
  shows: readonly PodcastShow[] | undefined;
  /** Dismiss, where the server offers it; shown only on a row that failed or was cancelled. */
  onDismiss?: (request: PodcastRequest) => void;
  dismissing: boolean;
}) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const { openPodcastShow } = useOpen();
  const open = isOpenRequest(request);
  const failed = !open && request.state !== 'done' && request.state !== 'cancelled';
  const show = requestShow(request);
  const label = requestLabel(request, shows);
  return (
    <RowSurface testID={`follow-request-${request.id}`} className="flex-row items-center gap-3 p-3">
      <Icon
        name={open ? 'clock' : failed ? 'circle-exclamation' : 'circle-check'}
        size={16}
        color={failed ? themed.destructive : themed.mutedForeground}
      />
      <View className="min-w-0 flex-1 gap-0.5">
        <Text variant="label" numberOfLines={1} testID={`follow-request-title-${request.id}`}>
          {label}
        </Text>
        {label !== request.feed ? (
          <Text variant="caption" numberOfLines={1}>
            {request.feed}
          </Text>
        ) : null}
        <View className="flex-row flex-wrap items-center gap-2">
          <Text variant="caption">{t(requestStateKey(request))}</Text>
          {request.private ? (
            <Badge variant="outline">
              <Text>{t('podcasts.shows.privateBadge')}</Text>
            </Badge>
          ) : null}
        </View>
        {failed ? (
          <Text variant="caption" testID={`follow-request-reason-${request.id}`}>
            {t(requestReasonKey(request.error?.code))}
          </Text>
        ) : null}
      </View>
      {show ? (
        <Button
          variant="outline"
          size="sm"
          title={t('podcasts.requests.openShow')}
          onPress={() => openPodcastShow(connectionId, show.libraryId, show.path)}
        />
      ) : null}
      {onDismiss && !open && request.state !== 'done' ? (
        <Button
          variant="ghost"
          size="icon"
          loading={dismissing}
          onPress={() => onDismiss(request)}
          accessibilityLabel={t('podcasts.requests.dismissLabel', { title: label })}
          testID={`follow-request-dismiss-${request.id}`}
        >
          <Icon name="close" size={16} color={themed.mutedForeground} />
        </Button>
      ) : null}
    </RowSurface>
  );
}
