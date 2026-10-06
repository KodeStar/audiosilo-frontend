import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Platform, Pressable, View } from 'react-native';

import type { UseQueryResult } from '@tanstack/react-query';

import { useLibraryBooks } from '@/api/hooks';
import type { PeopleList, PersonCount } from '@/api/types';
import { BookCover } from '@/components/library/book-cover';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { formatDuration } from '@/lib/format';
import { useLayout } from '@/lib/layout';
import { useOpen } from '@/lib/open';
import { cn } from '@/lib/utils';
import { tabularNums } from '@/theme/tabular-nums';

import { CardGrid } from './card-grid';
import { EmptyShelf } from './empty-shelf';
import type { ProgressLookup } from './series-model';
import { Portrait } from './portrait';
import { useProgressLookup } from './use-series-data';

export type PersonKind = 'author' | 'narrator';

const FAN = 4;
const FAN_COVER = 34;
const SKELETON = [0, 1, 2, 3, 4, 5, 6, 7];

const CARD = cn(
  'items-center gap-2.5 rounded-[18px] border border-border bg-card px-3.5 pb-[18px] pt-[22px]',
  Platform.select({
    web: 'cursor-pointer outline-none transition-colors hover:border-border-strong focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
  }),
);

/** "4 books · 31h 20m": a person's line. */
function personLine(p: PersonCount, t: ReturnType<typeof useTranslation>['t']): string {
  return [t('people.books', { count: p.books }), formatDuration(p.duration)]
    .filter(Boolean)
    .join(' · ');
}

/**
 * The Library tab's Authors or Narrators mode for the selected library: a portrait card
 * per person (name, books and length, a small fan of their covers), A-Z heads on a long
 * list, each opening the person's page; and a note for the books with no name in that
 * field (the server counts them, but an empty filter can't list them). Only offered with
 * `browse_people`.
 */
export function PeopleMode({
  kind,
  connectionId,
  libraryId,
  list,
}: {
  kind: PersonKind;
  connectionId: string;
  libraryId: number;
  /** `useAuthors` or `useNarrators` for the library. */
  list: Pick<UseQueryResult<PeopleList>, 'data' | 'isPending' | 'refetch'>;
}) {
  const { t } = useTranslation();
  const phone = useLayout() === 'phone';
  const { progressOf } = useProgressLookup();
  const minWidth = 176;

  if (list.isPending) {
    return (
      <CardGrid
        testID="people-mode-loading"
        data={SKELETON}
        keyExtractor={String}
        renderItem={() => <PersonCardSkeleton size={phone ? 72 : 86} />}
        minWidth={minWidth}
        phoneColumns={2}
      />
    );
  }
  if (!list.data) {
    return (
      <EmptyShelf
        title={t('people.errorTitle')}
        hint={t('series.error.hint')}
        action={{ label: t('common.retry'), icon: 'rotate', onPress: () => void list.refetch() }}
      />
    );
  }
  const { people, unknown } = list.data;
  if (people.length === 0) {
    return (
      <EmptyShelf
        title={kind === 'author' ? t('people.emptyAuthors') : t('people.emptyNarrators')}
        hint={t('people.emptyHint')}
        action={{
          label: t('series.mode.emptyAction'),
          onPress: () => router.setParams({ mode: undefined }),
        }}
      />
    );
  }
  return (
    <CardGrid
      data={people}
      keyExtractor={(p) => p.name}
      name={(p) => p.name}
      minWidth={minWidth}
      phoneColumns={2}
      renderItem={(p) => (
        <PersonCard
          person={p}
          kind={kind}
          connectionId={connectionId}
          libraryId={libraryId}
          progressOf={progressOf}
          size={phone ? 72 : 86}
        />
      )}
      ListFooterComponent={
        unknown > 0 ? (
          <Text variant="caption" className="px-4 pb-4 lg:px-8" style={tabularNums}>
            {kind === 'author'
              ? t('people.unknownAuthor', { count: unknown })
              : t('people.unknownNarrator', { count: unknown })}
          </Text>
        ) : null
      }
    />
  );
}

/** One person's card. Its cover fan reads the first page of their books, fetched when
 * the card first shows; the finished count comes from the same page. */
function PersonCard({
  person,
  kind,
  connectionId,
  libraryId,
  progressOf,
  size,
}: {
  person: PersonCount;
  kind: PersonKind;
  connectionId: string;
  libraryId: number;
  progressOf: ProgressLookup;
  size: number;
}) {
  const { t } = useTranslation();
  const { openAuthor, openNarrator } = useOpen();
  const books = useLibraryBooks(
    libraryId,
    kind === 'author' ? { author: person.name } : { narrator: person.name },
    connectionId,
  ).data?.pages[0]?.books;
  const finished =
    books?.filter((b) => progressOf(connectionId, b.library_id, b.rel_path)?.finished).length ?? 0;
  const line = [personLine(person, t), finished ? t('people.finished', { count: finished }) : '']
    .filter(Boolean)
    .join(' · ');
  const open = kind === 'author' ? openAuthor : openNarrator;
  return (
    <Pressable
      onPress={() => open(connectionId, libraryId, person.name)}
      accessibilityRole="button"
      accessibilityLabel={`${person.name}, ${line}`}
      className={CARD}
    >
      <Portrait name={person.name} kind={kind} size={size} />
      <View className="w-full items-center gap-0.5">
        <Text
          className="text-center font-display text-[15px] tracking-tight text-foreground"
          numberOfLines={1}
        >
          {person.name}
        </Text>
        <Text variant="caption" className="text-center" numberOfLines={2} style={tabularNums}>
          {line}
        </Text>
      </View>
      <View
        className="h-[38px] flex-row items-center justify-center"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {(books ?? []).slice(0, FAN).map((b, i, all) => (
          <View
            key={b.rel_path}
            style={{
              marginLeft: i === 0 ? 0 : -10,
              transform: [{ rotate: `${(i - (all.length - 1) / 2) * 6}deg` }],
            }}
          >
            <BookCover
              connectionId={connectionId}
              libraryId={b.library_id}
              path={b.rel_path}
              coverVersion={b.cover_version}
              width={FAN_COVER}
            />
          </View>
        ))}
      </View>
    </Pressable>
  );
}

function PersonCardSkeleton({ size }: { size: number }) {
  return (
    <View
      className={CARD}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <View style={{ width: size, height: size }}>
        <Skeleton className="h-full w-full rounded-full" />
      </View>
      <Skeleton className="h-4 w-3/4 rounded-sm" />
      <Skeleton className="h-3 w-1/2 rounded-sm" />
      <View className="h-[38px]" />
    </View>
  );
}
