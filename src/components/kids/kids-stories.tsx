import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';

import type { Book } from '@/api/types';
import { BookCover } from '@/components/library/book-cover';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Spinner } from '@/components/ui/spinner';
import { FOCUS_RING_OFFSET_CLASS, Text } from '@/components/ui/text';
import { contentKey } from '@/lib/content-key';
import { cn } from '@/lib/utils';
import { selectBookKey, usePlayer } from '@/playback/store';
import { useThemeColors } from '@/theme/use-theme-colors';

import { kidsColumns } from './kids-model';
import type { KidsStories } from './use-kids';

/** One story: a big rounded cover and its title. The loaded story says so (an ink pill;
 * the view's one pink thing is the player's progress line). */
function StoryTile({
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
}

/** A centred message: an icon, a title, a line and maybe an action. */
function Message({
  icon,
  title,
  body,
  action,
}: {
  icon: 'book' | 'offline' | 'circle-exclamation';
  title: string;
  body?: string;
  action?: { label: string; onPress: () => void };
}) {
  const themed = useThemeColors();
  return (
    <View className="items-center gap-3 rounded-[24px] bg-card px-6 py-10" testID="kids-message">
      <Icon name={icon} size={36} color={themed.mutedForeground} />
      <Text className="text-center font-display text-2xl text-foreground">{title}</Text>
      {body ? (
        <Text className="max-w-[420px] text-center font-sans text-base text-muted-foreground">
          {body}
        </Text>
      ) : null}
      {action ? (
        <Button size="xl" title={action.label} onPress={action.onPress} className="mt-2" />
      ) : null}
    </View>
  );
}

/**
 * Kids mode's stories: a grid of big cover tiles (2 columns on a phone, as many 180 pt
 * tiles as fit wider, by the measured `width`), continue-listening first (`kidsShelf`),
 * each tap playing the story (`onPlay`). Loading, empty, error and offline states: offline
 * with stories downloaded, those (with a line saying why), else a message with Try again.
 */
export function KidsStoriesGrid({
  stories,
  connectionId,
  width,
  phone,
  onPlay,
  onRetry,
}: {
  stories: KidsStories;
  connectionId: string | null;
  width: number;
  phone: boolean;
  onPlay: (book: Book) => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const loadedKey = usePlayer(selectBookKey);

  if (stories.status === 'loading') {
    return (
      <View className="items-center gap-3 py-12" testID="kids-loading">
        <Spinner size="large" />
        <Text className="font-sans text-base text-muted-foreground">
          {t('kids.stories.loading')}
        </Text>
      </View>
    );
  }
  if (stories.status === 'no-connection') {
    return <Message icon="book" title={t('kids.stories.emptyTitle')} />;
  }
  if (stories.status === 'empty') {
    return (
      <Message
        icon="book"
        title={t('kids.stories.emptyTitle')}
        body={t('kids.stories.emptyBody', { server: stories.serverName })}
      />
    );
  }
  if (stories.status === 'error') {
    return (
      <Message
        icon={stories.offline ? 'offline' : 'circle-exclamation'}
        title={t('kids.stories.errorTitle')}
        body={
          stories.offline
            ? t('kids.stories.offlineBody', { server: stories.serverName })
            : t('kids.stories.errorBody', { server: stories.serverName })
        }
        action={{ label: t('kids.stories.retry'), onPress: onRetry }}
      />
    );
  }

  const gap = phone ? 16 : 24;
  const columns = kidsColumns(width, phone ? 140 : 180, gap);
  const tile = width > 0 ? Math.floor((width - gap * (columns - 1)) / columns) : 150;
  return (
    <View className="gap-4">
      {stories.offline ? (
        <View className="flex-row items-center gap-2" testID="kids-offline-note">
          <Icon name="hard-drive" size={16} />
          <Text className="flex-1 font-sans text-base text-muted-foreground">
            {t('kids.stories.onDevice')}
          </Text>
        </View>
      ) : null}
      <View className="flex-row flex-wrap" style={{ columnGap: gap, rowGap: gap + 8 }}>
        {connectionId
          ? stories.books.map((b) => (
              <StoryTile
                key={b.rel_path}
                book={b}
                connectionId={connectionId}
                width={tile}
                loaded={loadedKey === contentKey(connectionId, b.library_id, b.rel_path)}
                onPlay={onPlay}
              />
            ))
          : null}
      </View>
    </View>
  );
}
