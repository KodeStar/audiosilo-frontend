import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { CapabilityError, useFollowPodcastByUrl } from '@/api/hooks';
import type { PodcastShow } from '@/api/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { useOpen } from '@/lib/open';

import { feedAddressProblem, followByUrlErrorKey } from './find-shows-model';

/** What the follow answered. `publicAlready`: asked as a private feed, but the library
 * already had the show as a public one, so the follow joined it as it is. */
type Outcome =
  { kind: 'following'; show: PodcastShow; publicAlready: boolean } | { kind: 'adding' };

/**
 * Follow a feed by its address (Bridge Phase 2d-2): a pasted RSS address, checked here
 * first (http(s) with a host, at most 2,048 bytes) so a bad one sends nothing, and a
 * Private feed switch for a feed made for the listener alone (sent as `private: true`
 * only when on). A show the library has is followed at once (Open show), and the page
 * says so when it was asked for as private but the library has it as a public feed; a new
 * one is a request the page's list follows until it is added.
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
  const follow = useFollowPodcastByUrl(connectionId);
  const [address, setAddress] = useState('');
  const [isPrivate, setPrivate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const submit = () => {
    // The keyboard's Go submits too, so a follow on its way holds both.
    if (follow.isPending) return;
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
            : { kind: 'adding' },
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
      <Button
        icon="plus"
        title={t('podcasts.find.address.submit')}
        loading={follow.isPending}
        onPress={submit}
        className="self-start"
        testID="follow-by-url-submit"
      />
      {outcome?.kind === 'following' ? (
        <View className="flex-row flex-wrap items-center gap-3" accessibilityLiveRegion="polite">
          <Text variant="body" testID="follow-by-url-following">
            {t(
              outcome.publicAlready
                ? 'podcasts.find.address.followingPublic'
                : 'podcasts.find.address.following',
              { title: outcome.show.title },
            )}
          </Text>
          <Button
            variant="outline"
            size="sm"
            title={t('podcasts.find.search.openShow')}
            onPress={() =>
              openPodcastShow(connectionId, outcome.show.library_id, outcome.show.path)
            }
          />
        </View>
      ) : outcome?.kind === 'adding' ? (
        <Text variant="body" accessibilityLiveRegion="polite" testID="follow-by-url-adding">
          {t('podcasts.find.address.adding')}
        </Text>
      ) : null}
    </View>
  );
}
