import { FlashList, type FlashListRef } from '@shopify/flash-list';
import type { TFunction } from 'i18next';
import { memo, type ReactElement, type Ref } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, type StyleProp, View, type ViewStyle } from 'react-native';

import type { Book } from '@/api/types';
import { BookCover } from '@/components/library/book-cover';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Icon } from '@/components/ui/icon';
import { Spinner } from '@/components/ui/spinner';
import { FOCUS_RING_OFFSET_CLASS, Text } from '@/components/ui/text';
import { contentKey } from '@/lib/content-key';
import type { LayoutClass } from '@/lib/layout';
import { cn } from '@/lib/utils';
import { selectBookKey, usePlayer } from '@/playback/store';
import { useThemeColors } from '@/theme/use-theme-colors';

import { kidsGrid } from './kids-model';
import type { KidsStories } from './use-kids';

/** One story: a big rounded cover and its title. The loaded story says so (an ink pill;
 * the view's one pink thing is the player's progress line). Memoised: a row re-renders
 * on a book switch, and only the tiles whose `loaded` changed redraw. */
const StoryTile = memo(function StoryTile({
  book,
  connectionId,
  width,
  loaded,
  onPlay,
}: {
  book: Book;
  connectionId: string;
  width: number;
  loaded: boolean;
  onPlay: (book: Book) => void;
}) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  return (
    <AnimatedPressable
      onPress={() => onPlay(book)}
      accessibilityRole="button"
      accessibilityLabel={t('kids.stories.play', { title: book.title })}
      accessibilityState={{ selected: loaded }}
      testID={`kids-story-${book.rel_path}`}
      className={cn(
        'items-center gap-2.5 rounded-[22px]',
        Platform.select({ web: cn('cursor-pointer', FOCUS_RING_OFFSET_CLASS) }),
      )}
      style={{ width }}
    >
      <View>
        <BookCover
          connectionId={connectionId}
          libraryId={book.library_id}
          path={book.rel_path}
          coverVersion={book.cover_version}
          width={width}
          title={book.title}
          author={book.author}
          className="rounded-[22px]"
        />
        {loaded ? (
          <View className="absolute bottom-2.5 left-2.5 flex-row items-center gap-1.5 rounded-full bg-primary px-3 py-1.5">
            <Icon name="play" size={12} color={themed.primaryForeground} />
            <Text className="font-sans-semibold text-sm text-primary-foreground">
              {t('kids.stories.playing')}
            </Text>
          </View>
        ) : null}
      </View>
      <Text
        className="text-center font-display-semibold text-lg leading-tight text-foreground"
        numberOfLines={2}
      >
        {book.title}
      </Text>
    </AnimatedPressable>
  );
});

/** One line of the list: a row of stories, or a collection's name over its stories. */
export type KidsRow =
  { key: string; books: Book[]; heading?: undefined } | { key: string; heading: string };

/** Rows of `columns` stories: the list is virtualised by row, so a column count of the
 * measured width needs no remount and each row lays its own gaps. */
function rowsOf(books: readonly Book[], columns: number, prefix = ''): KidsRow[] {
  const rows: KidsRow[] = [];
  for (let i = 0; i < books.length; i += columns) {
    const row = books.slice(i, i + columns);
    rows.push({ key: `${prefix}${row[0].library_id}:${row[0].rel_path}`, books: row });
  }
  return rows;
}

/** The list's lines: the stories in rows, each titled section (several collections) under
 * its own heading. */
function linesOf(ready: Extract<KidsStories, { status: 'ready' }>, columns: number): KidsRow[] {
  if (!ready.sections) return rowsOf(ready.books, columns);
  return ready.sections.flatMap((section) => [
    { key: `${section.key}:title`, heading: section.title },
    ...rowsOf(section.books, columns, `${section.key}:`),
  ]);
}

/** "Ask a grown-up to sign Leo in again." (no name: "...to sign you in again"): the
 * kid's sign-in ended, and signing in is a grown-up's (8b-1, D1/D4). */
export function askToSignIn(name: string, t: TFunction): string {
  return name ? t('kids.signedOut.ask', { name }) : t('kids.signedOut.askNoName');
}

/** The grid's state when it has no stories to show: loading, empty, an error, or the
 * kid's sign-in ended (say so and who can fix it, with no Try again that can't help). */
function StoriesState({
  stories,
  name,
  onRetry,
}: {
  stories: KidsStories;
  name: string;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  switch (stories.status) {
    case 'ready':
      return null;
    case 'loading':
      return (
        <View className="items-center gap-3 py-12" testID="kids-loading">
          <Spinner size="large" />
          <Text className="font-sans text-base text-muted-foreground">
            {t('kids.stories.loading')}
          </Text>
        </View>
      );
    case 'no-connection':
      return (
        <EmptyState variant="card" size="large" icon="book" title={t('kids.stories.emptyTitle')} />
      );
    case 'empty':
      return (
        <EmptyState
          variant="card"
          size="large"
          icon="book"
          title={t('kids.stories.emptyTitle')}
          hint={
            stories.askGrownUp
              ? t('kids.stories.askGrownUp')
              : t('kids.stories.emptyBody', { server: stories.serverName })
          }
        />
      );
    case 'signed-out':
      return (
        <EmptyState
          variant="card"
          size="large"
          icon="key"
          title={t('kids.signedOut.title', { server: stories.serverName })}
          hint={askToSignIn(name, t)}
        />
      );
    case 'error':
      return (
        <EmptyState
          variant="card"
          size="large"
          icon={stories.offline ? 'offline' : 'circle-exclamation'}
          title={t('kids.stories.errorTitle')}
          hint={
            stories.offline
              ? t('kids.stories.offlineBody', { server: stories.serverName })
              : t('kids.stories.errorBody', { server: stories.serverName })
          }
          action={{ label: t('kids.stories.retry'), onPress: onRetry }}
        />
      );
  }
}

/**
 * Kids mode's page as one virtualised list (FlashList): the page's `header` (greeting,
 * bedtime card, player, the Stories heading), then the stories as big cover tiles (2
 * columns on a phone, as many 180 pt tiles as fit wider, by the content column's measured
 * `width`: `kidsGrid`), continue-listening first, each tap playing the story (`onPlay`);
 * several collections shared by the kid's owner each come under their own name.
 * Rows mount as they scroll in, and the next page of the library is asked for near the
 * end (`onEndReached`). Loading, empty, error and offline states: offline with stories
 * downloaded, those (with a line saying why), else a message with Try again; a page that
 * failed to load further down says so and offers Try again under the grid. A kid whose
 * sign-in ended (`signed-out`, or `signedOut` stories) is told to ask a grown-up instead,
 * with no Try again.
 */
export function KidsStoriesList({
  stories,
  connectionId,
  width,
  layout,
  header,
  onPlay,
  onRetry,
  onEndReached,
  listRef,
  contentContainerStyle,
  name = '',
}: {
  stories: KidsStories;
  connectionId: string | null;
  width: number;
  layout: LayoutClass;
  header: ReactElement;
  onPlay: (book: Book) => void;
  onRetry: () => void;
  onEndReached: () => void;
  listRef?: Ref<FlashListRef<KidsRow>>;
  contentContainerStyle?: StyleProp<ViewStyle>;
  /** The kid's name, for "Ask a grown-up to sign <name> in again." */
  name?: string;
}) {
  const { t } = useTranslation();
  const loadedKey = usePlayer(selectBookKey);
  const { columns, tile, columnGap, rowGap } = kidsGrid(width, layout);
  const ready = stories.status === 'ready' ? stories : null;
  const rows = ready && connectionId ? linesOf(ready, columns) : [];

  return (
    <FlashList
      ref={listRef}
      data={rows}
      keyExtractor={(row) => row.key}
      getItemType={(row) => (row.heading !== undefined ? 'heading' : 'row')}
      extraData={`${loadedKey}|${tile}|${columnGap}`}
      renderItem={({ item }) =>
        item.heading !== undefined ? (
          <Text
            accessibilityRole="header"
            numberOfLines={2}
            className="mb-3 font-display-semibold text-xl tracking-tight text-foreground"
          >
            {item.heading}
          </Text>
        ) : (
          <View className="flex-row" style={{ columnGap, paddingBottom: rowGap }}>
            {item.books.map((b) => (
              <StoryTile
                key={`${b.library_id}:${b.rel_path}`}
                book={b}
                connectionId={connectionId as string}
                width={tile}
                loaded={loadedKey === contentKey(connectionId as string, b.library_id, b.rel_path)}
                onPlay={onPlay}
              />
            ))}
          </View>
        )
      }
      ListHeaderComponent={
        <View>
          {header}
          {ready?.offline ? (
            <View className="mb-4 flex-row items-center gap-2" testID="kids-offline-note">
              <Icon name="hard-drive" size={16} />
              <Text className="flex-1 font-sans text-base text-muted-foreground">
                {t('kids.stories.onDevice')}
              </Text>
            </View>
          ) : null}
        </View>
      }
      ListEmptyComponent={<StoriesState stories={stories} name={name} onRetry={onRetry} />}
      ListFooterComponent={
        ready?.more === 'loading' ? (
          <View className="items-center py-6" testID="kids-more-loading">
            <Spinner />
          </View>
        ) : ready?.more === 'failed' && !ready.signedOut ? (
          // Says what failed (never a bare Try again). Signed out, asking again can't
          // help, and the notice over the stories already says who can.
          <View className="items-center gap-3 py-6" testID="kids-more-failed">
            <Text className="text-center font-sans text-base text-muted-foreground">
              {t('kids.stories.moreFailed')}
            </Text>
            <Button size="xl" title={t('kids.stories.retry')} onPress={onRetry} />
          </View>
        ) : null
      }
      onEndReached={onEndReached}
      onEndReachedThreshold={0.5}
      contentContainerStyle={contentContainerStyle}
    />
  );
}
