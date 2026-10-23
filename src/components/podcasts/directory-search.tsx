import { type ReactElement, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, View } from 'react-native';

import {
  CapabilityError,
  type PodcastSearchParams,
  useCapability,
  useFollowPodcastByUrl,
  usePodcastDiscoveryProviders,
  usePodcastSearch,
} from '@/api/hooks';
import type { PodcastDiscoveryProvider, PodcastDiscoveryResult } from '@/api/types';
import { pageGutter } from '@/components/library/cover-layout';
import { useMiniPlayerInset } from '@/components/player/mini-player';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { TAB_PAGE_SCROLL_PROPS } from '@/components/shell/tab-page-scroll';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { SegmentedControl } from '@/components/ui/toggle-group';
import { useLayout } from '@/lib/layout';
import { useOpen } from '@/lib/open';

import { DiscoveryResultRow, type ResultOutcome } from './discovery-result-row';
import { deviceCountry } from './discovery-country';
import {
  cleanSearchText,
  followByUrlErrorKey,
  MIN_SEARCH_LENGTH,
  searchErrorCopy,
} from './find-shows-model';

/** Results per search (the server's default, sent explicitly). */
const SEARCH_LIMIT = 20;

const sameSearch = (a: PodcastSearchParams | null, b: PodcastSearchParams) =>
  !!a && a.q === b.q && a.provider === b.provider && a.country === b.country && a.limit === b.limit;

/**
 * Find shows' directory search (Bridge Phase 2d-2, capability `podcast_discovery`). It
 * searches only when submitted (never while typing; the per-person budget is small), and
 * an unchanged repeat reuses the held results. Apple Podcasts unless the server has
 * Podcast Index too, when a picker chooses (never retried on the other one); the country
 * is the device's region, for Apple only. A result's Follow is a follow by its feed
 * address. The results are the page's one scroller, `header` above them and `footer`
 * (the follow requests) below.
 */
export function DirectorySearch({
  connectionId,
  libraryId,
  header,
  footer,
}: {
  connectionId: string;
  libraryId: number;
  header: ReactElement;
  footer: ReactElement;
}) {
  const { t } = useTranslation();
  const gutter = pageGutter(useLayout());
  const paddingBottom = useMiniPlayerInset();
  const { openPodcastShow } = useOpen();
  const canFollow = useCapability('podcasts', connectionId) === true;
  const providers = usePodcastDiscoveryProviders(connectionId);
  const indexAvailable =
    providers.data?.providers.some((p) => p.id === 'podcast_index' && p.available) === true;
  const [picked, setPicked] = useState<PodcastDiscoveryProvider>('itunes');
  const provider: PodcastDiscoveryProvider = indexAvailable ? picked : 'itunes';
  const [text, setText] = useState('');
  const [tooShort, setTooShort] = useState(false);
  const [params, setParams] = useState<PodcastSearchParams | null>(null);
  const search = usePodcastSearch(params, connectionId);
  const follow = useFollowPodcastByUrl(connectionId);
  const [outcomes, setOutcomes] = useState<Record<string, ResultOutcome>>({});

  const submit = (using: PodcastDiscoveryProvider = provider) => {
    const q = cleanSearchText(text);
    if (q.length < MIN_SEARCH_LENGTH) {
      setTooShort(true);
      return;
    }
    setTooShort(false);
    const next: PodcastSearchParams = {
      q,
      provider: using,
      country: using === 'itunes' ? (deviceCountry() ?? null) : null,
      limit: SEARCH_LIMIT,
    };
    // The same search: its held results stand; asked again only after it failed.
    if (sameSearch(params, next)) {
      if (search.isError) void search.refetch();
      return;
    }
    setParams(next);
  };

  const setOutcome = (feedUrl: string, outcome: ResultOutcome | undefined) =>
    setOutcomes(({ [feedUrl]: _, ...rest }) => (outcome ? { ...rest, [feedUrl]: outcome } : rest));

  const followResult = (r: PodcastDiscoveryResult) => {
    setOutcome(r.feed_url, { kind: 'busy' });
    follow.mutateAsync({ libraryId, feedUrl: r.feed_url }).then(
      (answer) =>
        setOutcome(
          r.feed_url,
          answer.state === 'following'
            ? { kind: 'following', libraryId: answer.show.library_id, path: answer.show.path }
            : { kind: 'adding' },
        ),
      (e: unknown) => {
        setOutcome(r.feed_url, undefined);
        if (!(e instanceof CapabilityError)) toast({ title: t(followByUrlErrorKey(e)) });
      },
    );
  };

  const answered = search.data;
  const providerName = t(`podcasts.find.provider.${answered?.provider ?? provider}`);
  const failure = params && search.isError ? searchErrorCopy(search.error) : null;

  const form = (
    <View className="gap-3 pb-4">
      {indexAvailable ? (
        <SegmentedControl
          options={[
            { value: 'itunes', label: t('podcasts.find.provider.itunes') },
            { value: 'podcast_index', label: t('podcasts.find.provider.podcast_index') },
          ]}
          value={provider}
          onChange={(next) => {
            setPicked(next);
            if (params) submit(next);
          }}
          accessibilityLabel={t('podcasts.find.search.providerLabel')}
          className="self-start"
        />
      ) : null}
      <View className="flex-row items-end gap-2">
        <Input
          testID="directory-search-input"
          containerClassName="min-w-0 flex-1"
          label={t('podcasts.find.search.label')}
          placeholder={t('podcasts.find.search.placeholder')}
          value={text}
          onChangeText={(v) => {
            setText(v);
            if (tooShort) setTooShort(false);
          }}
          onSubmitEditing={() => submit()}
          returnKeyType="search"
          autoCorrect={false}
          error={tooShort ? t('podcasts.find.search.tooShort') : undefined}
        />
        <Button
          icon="search"
          title={t('podcasts.find.search.submit')}
          onPress={() => submit()}
          loading={search.isFetching}
          testID="directory-search-submit"
          className={tooShort ? 'mb-6' : undefined}
        />
      </View>
      {(answered?.results.length ?? 0) > 0 || (!indexAvailable && !failure) ? (
        <Text variant="caption" testID="directory-attribution">
          {t('podcasts.find.search.resultsFrom', { provider: providerName })}
        </Text>
      ) : null}
      {failure ? (
        <View className="gap-2" accessibilityLiveRegion="polite" testID="directory-search-error">
          <Text variant="body">{t(failure.key, { seconds: failure.seconds })}</Text>
          <Button
            variant="outline"
            size="sm"
            icon="rotate"
            title={t('podcasts.find.search.searchAgain')}
            onPress={() => void search.refetch()}
            className="self-start"
          />
        </View>
      ) : null}
    </View>
  );

  const empty =
    !params || failure ? null : search.isPending || (search.isFetching && !answered) ? (
      <View
        className="items-center gap-2 py-6"
        accessibilityLabel={t('podcasts.find.search.loading')}
      >
        <Spinner />
      </View>
    ) : (
      <EmptyState
        icon="search"
        title={t('podcasts.find.search.noResults')}
        hint={t('podcasts.find.search.noResultsHint')}
      />
    );

  return (
    <FlatList
      testID="directory-search"
      data={failure ? [] : (answered?.results ?? [])}
      keyExtractor={(r) => r.feed_url}
      {...TAB_PAGE_SCROLL_PROPS}
      initialNumToRender={8}
      windowSize={5}
      renderItem={({ item }) => (
        <DiscoveryResultRow
          connectionId={connectionId}
          result={item}
          providerName={providerName}
          outcome={outcomes[item.feed_url]}
          canFollow={canFollow}
          onFollow={() => followResult(item)}
          onOpenShow={(lib, path) => openPodcastShow(connectionId, lib, path)}
        />
      )}
      ListHeaderComponent={
        <>
          {header}
          {form}
        </>
      }
      ListEmptyComponent={empty}
      ListFooterComponent={footer}
      contentContainerStyle={{ paddingHorizontal: gutter, paddingBottom: paddingBottom + 24 }}
    />
  );
}
