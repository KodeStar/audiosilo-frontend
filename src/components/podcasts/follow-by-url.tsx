import { useIsFocused } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import {
  CapabilityError,
  useFollowPodcastByUrl,
  useFollowRequests,
  usePodcastShows,
} from '@/api/hooks';
import type { PodcastShow } from '@/api/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { useDeviceOnline } from '@/lib/device-online';
import { useOpen } from '@/lib/open';

import {
  feedAddressProblem,
  followByUrlErrorKey,
  requestEnd,
  requestLabel,
} from './find-shows-model';
import { requestReasonKey } from './podcast-model';

/** What the follow answered. `publicAlready`: asked as a private feed, but the library
 * already had the show as a public one, so the follow joined it as it is. `adding`: a
 * request on its way, read live until it ends (fe#126). */
type Outcome =
  | { kind: 'following'; show: PodcastShow; publicAlready: boolean }
  | { kind: 'adding'; requestId: number };

/**
 * Follow a feed by its address (Bridge Phase 2d-2): a pasted RSS address, checked here
 * first (http(s) with a host, at most 2,048 bytes) so a bad one sends nothing, and a
 * Private feed switch for a feed made for the listener alone (sent as `private: true`
 * only when on). A show the library has is followed at once (Open show), and the page
 * says so when it was asked for as private but the library has it as a public feed; a new
 * one is a request read live from the follow requests (the page's list polls them) until
 * it ends: followed with Open show, or why it could not be added, or cancelled, never
 * "Adding" after it failed (fe#126).
 */
export function FollowByUrl({
  connectionId,
  libraryId,
}: {
  connectionId: string;
  libraryId: number;
}) {
  const { t } = useTranslation();
  const { openPodcastShow } = useOpen();
  const online = useDeviceOnline();
  const follow = useFollowPodcastByUrl(connectionId);
  const [address, setAddress] = useState('');
  const [isPrivate, setPrivate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const focused = useIsFocused();
  const { data: requests } = useFollowRequests(libraryId, { active: focused }, connectionId);
  const { data: shows } = usePodcastShows(libraryId, connectionId);
  // How the request on its way ended (null while open or not read yet, `unknown` once the
  // list no longer holds it: what the follow answered stands then).
  const ended = outcome?.kind === 'adding' ? requestEnd(requests, outcome.requestId) : null;
  const request =
    outcome?.kind === 'adding' ? requests?.find((r) => r.id === outcome.requestId) : undefined;
  // The show it follows now: the follow's own answer, or the request that ended added.
  const followed =
    outcome?.kind === 'following'
      ? {
          title: outcome.show.title,
          libraryId: outcome.show.library_id,
          path: outcome.show.path,
          publicAlready: outcome.publicAlready,
        }
      : ended?.kind === 'following'
        ? {
            title: request ? requestLabel(request, shows) : ended.path,
            libraryId: ended.libraryId,
            path: ended.path,
            publicAlready: false,
          }
        : null;

  const submit = () => {
    // The keyboard's Go submits too, so a follow on its way holds both.
    if (!online || follow.isPending) return;
    const problem = feedAddressProblem(address);
    if (problem) {
      setError(t(`podcasts.find.address.${problem}`));
      return;
    }
    setError(null);
    setOutcome(null);
    const askedPrivate = isPrivate;
    follow.mutateAsync({ libraryId, feedUrl: address.trim(), private: askedPrivate }).then(
      (answer) => {
        setOutcome(
          answer.state === 'following'
            ? {
                kind: 'following',
                show: answer.show,
                publicAlready: askedPrivate && !answer.show.private,
              }
            : { kind: 'adding', requestId: answer.request.id },
        );
        setAddress('');
        setPrivate(false);
      },
      (e: unknown) => {
        if (!(e instanceof CapabilityError)) setError(t(followByUrlErrorKey(e)));
      },
    );
  };

  return (
    <View testID="follow-by-url" className="gap-4">
      <View className="gap-1.5">
        <Input
          testID="feed-address"
          label={t('podcasts.find.address.label')}
          placeholder={t('podcasts.find.address.placeholder')}
          value={address}
          onChangeText={(v) => {
            setAddress(v);
            if (error) setError(null);
          }}
          onSubmitEditing={submit}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          inputMode="url"
          returnKeyType="go"
          error={error ?? undefined}
        />
        <Text variant="caption">{t('podcasts.find.address.hint')}</Text>
      </View>
      <View className="flex-row items-start gap-3">
        <View className="min-w-0 flex-1 gap-0.5">
          <Text variant="label" nativeID="private-feed-label">
            {t('podcasts.find.address.private')}
          </Text>
          <Text variant="caption">{t('podcasts.find.address.privateHint')}</Text>
        </View>
        <Switch
          testID="private-feed"
          checked={isPrivate}
          onCheckedChange={setPrivate}
          accessibilityLabel={t('podcasts.find.address.private')}
        />
      </View>
      {!online ? <Text variant="muted">{t('podcasts.find.offline')}</Text> : null}
      <Button
        icon="plus"
        title={t('podcasts.find.address.submit')}
        disabled={!online}
        loading={online && follow.isPending}
        onPress={submit}
        className="self-start"
        testID="follow-by-url-submit"
      />
      {followed ? (
        <View className="flex-row flex-wrap items-center gap-3" accessibilityLiveRegion="polite">
          <Text variant="body" testID="follow-by-url-following">
            {t(
              followed.publicAlready
                ? 'podcasts.find.address.followingPublic'
                : 'podcasts.find.address.following',
              { title: followed.title },
            )}
          </Text>
          <Button
            variant="outline"
            size="sm"
            title={t('podcasts.find.search.openShow')}
            onPress={() => openPodcastShow(connectionId, followed.libraryId, followed.path)}
          />
        </View>
      ) : ended?.kind === 'failed' ? (
        <Text variant="body" accessibilityLiveRegion="polite" testID="follow-by-url-failed">
          {`${t('podcasts.find.address.failed')} ${t(requestReasonKey(ended.error?.code))}`}
        </Text>
      ) : ended?.kind === 'cancelled' ? (
        <Text variant="body" accessibilityLiveRegion="polite" testID="follow-by-url-cancelled">
          {t('podcasts.find.address.cancelled')}
        </Text>
      ) : outcome?.kind === 'adding' ? (
        <Text variant="body" accessibilityLiveRegion="polite" testID="follow-by-url-adding">
          {t('podcasts.find.address.adding')}
        </Text>
      ) : null}
    </View>
  );
}
