import { useTranslation } from 'react-i18next';
import { Linking, View } from 'react-native';

import type { PodcastDiscoveryResult } from '@/api/types';
import { Button } from '@/components/ui/button';
import { RowSurface } from '@/components/ui/row-surface';
import { Text } from '@/components/ui/text';

import { DiscoveryArtwork } from './discovery-artwork';

/** What following a result did: on its way (a request), or followed (the show). */
export type ResultOutcome =
  { kind: 'adding' } | { kind: 'following'; libraryId: number; path: string };

/**
 * One directory result (Bridge Phase 2d-2): its artwork (the server's proxy), title,
 * author and episode count, a link to the show's page on the directory (credit where the
 * result came from), and Follow, which becomes Adding (a request on its way) or Following
 * with Open show (the library had it).
 */
export function DiscoveryResultRow({
  connectionId,
  result,
  providerName,
  outcome,
  busy,
  canFollow,
  onFollow,
  onOpenShow,
}: {
  connectionId: string;
  result: PodcastDiscoveryResult;
  providerName: string;
  outcome: ResultOutcome | undefined;
  busy: boolean;
  canFollow: boolean;
  onFollow: () => void;
  onOpenShow: (libraryId: number, path: string) => void;
}) {
  const { t } = useTranslation();
  const providerUrl = result.provider_url;
  return (
    <RowSurface testID="discovery-result" className="mb-2 flex-row items-center gap-3 p-3">
      <DiscoveryArtwork connectionId={connectionId} artworkUrl={result.artwork_url} size={56} />
      <View className="min-w-0 flex-1 gap-0.5">
        <Text variant="label" numberOfLines={2}>
          {result.title}
        </Text>
        {result.author ? (
          <Text variant="caption" numberOfLines={1}>
            {result.author}
          </Text>
        ) : null}
        {result.episode_count !== null ? (
          <Text variant="caption">
            {t('podcasts.find.search.episodes', { count: result.episode_count })}
          </Text>
        ) : null}
        {providerUrl ? (
          <Button
            variant="link"
            size="sm"
            icon="arrow-up-right"
            title={t('podcasts.find.search.viewOn', { provider: providerName })}
            onPress={() => void Linking.openURL(providerUrl).catch(() => {})}
            className="self-start px-0"
          />
        ) : null}
      </View>
      <View className="items-end gap-1.5">
        {outcome?.kind === 'following' ? (
          <>
            <Text variant="caption">{t('podcasts.find.search.following')}</Text>
            <Button
              variant="outline"
              size="sm"
              title={t('podcasts.find.search.openShow')}
              onPress={() => onOpenShow(outcome.libraryId, outcome.path)}
            />
          </>
        ) : outcome?.kind === 'adding' ? (
          <Text variant="caption" testID="discovery-result-adding">
            {t('podcasts.find.search.adding')}
          </Text>
        ) : canFollow ? (
          <Button
            size="sm"
            icon="plus"
            title={t('podcasts.find.search.follow')}
            accessibilityLabel={t('podcasts.find.search.followLabel', { title: result.title })}
            loading={busy}
            onPress={onFollow}
          />
        ) : null}
      </View>
    </RowSurface>
  );
}
