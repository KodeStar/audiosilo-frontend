import { type ReactElement, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, View } from 'react-native';

import { useLibrariesOf, useLibrivoxSearch } from '@/api/hooks';
import type { LibrivoxHit } from '@/api/types';
import { OfflineState } from '@/components/layout/offline-state';
import { pageGutter } from '@/components/library/cover-layout';
import { useMiniPlayerInset } from '@/components/player/mini-player';
import { TAB_PAGE_SCROLL_PROPS } from '@/components/shell/tab-page-scroll';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { PressableRow } from '@/components/ui/row-surface';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { useLayout } from '@/lib/layout';
import { isPodcastLibrary } from '@/lib/library-kind';
import { useUnreadQuery } from '@/lib/offline-state';
import { useThemeColors } from '@/theme/use-theme-colors';

import { namesLine, readErrorKey } from './librivox-model';
import { LibrivoxWorkPanel } from './librivox-work';

/**
 * Find on LibriVox's search (LibriVox L6): a query asked only when submitted (never while
 * typing), the works that match (title, authors, first release, language), and under the
 * one opened its LibriVox recordings, each with Add (`LibrivoxWorkPanel`). Add puts the
 * book into the library the page was opened from, or the one picked above the results
 * when the server has several books libraries. The results are the page's one scroller,
 * `header` above them. A link naming a library this server has no books library for (a
 * link without `?connection=` reads the default server's) gets the broken-link sentence
 * and nothing else: Add only ever goes to a library the link or the picker named.
 */
export function LibrivoxSearch({
  connectionId,
  libraryId,
  header,
  bridgeAway,
}: {
  connectionId: string;
  /** The library the page was opened from: Add's first choice. */
  libraryId: number;
  header: ReactElement;
  /** The Bridge went away while the page was open: Add is held back. */
  bridgeAway: boolean;
}) {
  const { t } = useTranslation();
  const gutter = pageGutter(useLayout());
  const paddingBottom = useMiniPlayerInset();
  const [text, setText] = useState('');
  const [asked, setAsked] = useState('');
  const search = useLibrivoxSearch(asked, connectionId);
  const [openWork, setOpenWork] = useState<string | null>(null);
  // The books libraries (a podcast library can't take a LibriVox book), in the server's
  // order; undefined until they are known.
  const librariesRead = useLibrariesOf(connectionId);
  const known = librariesRead.data?.filter((l) => !isPodcastLibrary(l));
  const libraries = known ?? [];
  const [picked, setPicked] = useState<number>(libraryId);
  const named = libraries.find((l) => l.id === libraryId);
  // Undefined while the libraries load; the named one when the picked one is gone.
  const target = libraries.find((l) => l.id === picked) ?? named;

  const submit = () => {
    const q = text.trim();
    if (!q) return;
    if (q === asked) {
      // The same search: its results stand; asked again only after it failed.
      if (search.isError) void search.refetch();
      return;
    }
    setOpenWork(null);
    setAsked(q);
  };

  // With nothing to show and no network (held for it, where it stays pending, or failed
  // without one): the offline state, never the spinner nor a Search again that can't work.
  const offline = useUnreadQuery(search) === 'offline';
  // Only with nothing to show: a search read again that failed (the app back in the
  // foreground reads every list again) keeps its results, and with them the work open
  // under them and the fetch each of its rows follows.
  const failure =
    asked && search.isError && !search.data && !offline ? readErrorKey(search.error) : null;
  const hits = search.data?.results ?? [];

  // Refused only on a settled list: a cached one read again (a library added since) may
  // hold it yet.
  if (known && !named && !librariesRead.isFetching) {
    return (
      <View testID="librivox-library-missing">
        <EmptyState icon="book" title={t('library.detail.badLink')} />
      </View>
    );
  }

  const form = (
    <View className="gap-3 pb-4">
      <View className="flex-row items-end gap-2">
        <Input
          testID="librivox-search-input"
          containerClassName="min-w-0 flex-1"
          label={t('librivox.search.label')}
          placeholder={t('librivox.search.placeholder')}
          value={text}
          onChangeText={setText}
          onSubmitEditing={submit}
          returnKeyType="search"
          autoCorrect={false}
        />
        <Button
          icon="search"
          title={t('librivox.search.submit')}
          onPress={submit}
          loading={search.isFetching}
          testID="librivox-search-submit"
        />
      </View>
      {libraries.length > 1 && target ? (
        <View className="flex-row flex-wrap items-center gap-x-3 gap-y-1.5">
          <Text variant="label">{t('librivox.library.label')}</Text>
          <Select
            value={{ value: String(target.id), label: target.name }}
            onValueChange={(o) => {
              const id = Number(o?.value);
              if (Number.isInteger(id)) setPicked(id);
            }}
          >
            <SelectTrigger
              className="min-w-[180px] shrink"
              accessibilityLabel={t('librivox.library.label')}
              testID="librivox-library"
            >
              <SelectValue placeholder={target.name} />
            </SelectTrigger>
            <SelectContent align="start">
              {libraries.map((l) => (
                <SelectItem key={l.id} value={String(l.id)} label={l.name} />
              ))}
            </SelectContent>
          </Select>
        </View>
      ) : null}
      {failure ? (
        <View className="gap-2" accessibilityLiveRegion="polite" testID="librivox-search-error">
          <Text variant="body">{t(failure)}</Text>
          <Button
            variant="outline"
            size="sm"
            icon="rotate"
            title={t('librivox.search.again')}
            onPress={() => void search.refetch()}
            className="self-start"
          />
        </View>
      ) : null}
    </View>
  );

  const empty =
    !asked || failure ? null : offline ? (
      <OfflineState hint={t('common.offlineList')} />
    ) : search.isPending ? (
      <View className="items-center py-6" accessibilityLabel={t('librivox.search.loading')}>
        <Spinner />
      </View>
    ) : (
      <EmptyState
        icon="search"
        title={t('librivox.search.none')}
        hint={t('librivox.search.noneHint')}
      />
    );

  return (
    <FlatList
      testID="librivox-search"
      data={hits}
      keyExtractor={(h) => h.work_id}
      extraData={`${openWork}:${target?.id}:${bridgeAway}`}
      {...TAB_PAGE_SCROLL_PROPS}
      initialNumToRender={8}
      windowSize={5}
      renderItem={({ item }) => (
        <View className="mb-2">
          <HitRow
            hit={item}
            open={item.work_id === openWork}
            onPress={() => setOpenWork(item.work_id === openWork ? null : item.work_id)}
          />
          {item.work_id === openWork ? (
            <LibrivoxWorkPanel
              connectionId={connectionId}
              workId={item.work_id}
              target={target}
              bridgeAway={bridgeAway}
            />
          ) : null}
        </View>
      )}
      ListHeaderComponent={
        <>
          {header}
          {form}
        </>
      }
      ListEmptyComponent={empty ?? undefined}
      contentContainerStyle={{ paddingHorizontal: gutter, paddingBottom: paddingBottom + 24 }}
    />
  );
}

/** One work found: its title, then its authors, first release and language; pressing it
 * opens (or closes) its recordings under it. */
function HitRow({ hit, open, onPress }: { hit: LibrivoxHit; open: boolean; onPress: () => void }) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const facts = [namesLine(hit.authors), hit.release_date, hit.language.toUpperCase()]
    .filter(Boolean)
    .join(' · ');
  return (
    <PressableRow
      testID="librivox-hit"
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      accessibilityLabel={t('librivox.work.show', { title: hit.title })}
      onPress={onPress}
      className="flex-row items-center gap-3 p-3"
    >
      <View className="min-w-0 flex-1 gap-0.5">
        <Text variant="label" numberOfLines={2}>
          {hit.title}
        </Text>
        {facts ? (
          <Text variant="caption" numberOfLines={2}>
            {facts}
          </Text>
        ) : null}
      </View>
      <Icon name={open ? 'chevron-up' : 'chevron-down'} size={16} color={themed.mutedForeground} />
    </PressableRow>
  );
}
