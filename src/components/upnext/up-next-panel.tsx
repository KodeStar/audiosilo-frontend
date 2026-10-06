import { useTranslation } from 'react-i18next';
import { Platform, Pressable, View } from 'react-native';

import { useBook } from '@/api/hooks';
import type { QueueEntry } from '@/api/types';
import { BookCover } from '@/components/library/book-cover';
import { GhostCover } from '@/components/library/ghost-cover';
import { useBookTimeLeft } from '@/components/player/book-progress';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Switch } from '@/components/ui/switch';
import { FOCUS_RING_CLASS, Text } from '@/components/ui/text';
import { chapterLabel } from '@/lib/chapter-label';
import { formatDuration } from '@/lib/format';
import { useLayout } from '@/lib/layout';
import { useOpen } from '@/lib/open';
import { bookTitle } from '@/lib/paths';
import { cn } from '@/lib/utils';
import {
  type NowPlaying,
  selectCurrentChapter,
  selectIsPlaying,
  usePlayer,
} from '@/playback/store';
import { useConnectionName, useSession } from '@/stores/session';
import { useSettings } from '@/stores/settings';
import { tabularNums } from '@/theme/tabular-nums';
import { useThemeColors } from '@/theme/use-theme-colors';

import { DropZone } from './drop-zone';
import { entryTitle, QueueList, QueueSkeleton } from './queue-list';
import type { Suggestion } from './up-next-model';
import { usePlayNow, useUpNextData } from './use-up-next';

/** "7h 2m queued" (with the server's name first when signed in to several). */
export function useQueuedLine(cid: string | undefined, seconds: number, count: number): string {
  const { t } = useTranslation();
  const several = useSession((s) => s.connections.length > 1);
  const name = useConnectionName(cid);
  const amount =
    count === 0 ? t('upnext.nothingQueued') : t('upnext.queued', { time: formatDuration(seconds) });
  return several && name ? `${name} · ${amount}` : amount;
}

/**
 * Up next's content (STYLEGUIDE section 8, "Up next"), shared by the desktop drawer and
 * the tablet/phone sheet: the book playing now, the queue (reorder, play now, remove,
 * Clear with Undo), the drop zone for covers (web desktop), "Continue the series and
 * more", and the auto-play switch. `onNavigate` runs before it opens a page (the sheet
 * closes itself then; the drawer stays).
 */
export function UpNextPanel({
  cid,
  data,
  onNavigate,
}: {
  cid: string;
  data: ReturnType<typeof useUpNextData>;
  onNavigate?: () => void;
}) {
  const { t } = useTranslation();
  const desktopWeb = useLayout() === 'desktop' && Platform.OS === 'web';
  const nowPlaying = usePlayer((s) => s.nowPlaying);
  const serverName = useConnectionName(cid);
  const { actions } = data;
  const playNow = usePlayNow(cid, data.dropPlayed);
  const { entries } = data;
  const loaded = nowPlaying?.connectionId === cid ? nowPlaying : null;

  return (
    <View className="pb-2">
      {loaded ? <NowPlayingCard nowPlaying={loaded} /> : null}

      <View className="flex-row items-center justify-between px-2 pb-1.5 pt-1.5">
        <Text variant="eyebrow" style={tabularNums}>
          {entries ? t('upnext.heading', { count: entries.length }) : t('upnext.title')}
        </Text>
        {entries && entries.length > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            title={t('upnext.clear')}
            accessibilityLabel={t('upnext.clearLabel')}
            disabled={data.busy}
            onPress={() => void data.clear(entries)}
          />
        ) : null}
      </View>

      {data.error ? (
        <View className="mx-1.5 mb-2 flex-row items-center gap-2 rounded-xl bg-muted px-3 py-2.5">
          <Text variant="caption" className="flex-1">
            {entries ? t('upnext.refreshFailed') : t('upnext.loadFailed')}
          </Text>
          <Button
            size="sm"
            variant="outline"
            title={t('common.retry')}
            onPress={() => void data.refetch()}
          />
        </View>
      ) : null}

      {entries === undefined ? (
        data.isLoading ? (
          <QueueSkeleton />
        ) : null
      ) : entries.length > 0 ? (
        <QueueList
          entries={entries}
          progress={data.progress}
          connectionId={cid}
          onMove={data.move}
          onRemove={(e: QueueEntry) => void actions.unqueue(e.library_id, e.path)}
          onPlay={(e: QueueEntry) => void playNow(e, entryTitle(e))}
        />
      ) : desktopWeb ? null : (
        <EmptyQueue />
      )}

      {desktopWeb && entries !== undefined ? (
        <DropZone
          connectionId={cid}
          serverName={serverName}
          empty={entries.length === 0}
          onDrop={(book) => void actions.queue(book.libraryId, book.path)}
        />
      ) : null}

      {data.suggestions.length > 0 ? (
        <View className="pt-4">
          <Text variant="eyebrow" className="px-2 pb-1.5">
            {t('upnext.suggestions')}
          </Text>
          {data.suggestions.map((s) => (
            <SuggestionRow
              key={s.kind === 'ghost' ? `ghost:${s.workId}` : `${s.ref.library_id}:${s.ref.path}`}
              suggestion={s}
              cid={cid}
              serverName={serverName}
              libraryId={loaded?.libraryId}
              onQueue={(lib, path) => void actions.queue(lib, path)}
              onNavigate={onNavigate}
            />
          ))}
        </View>
      ) : null}

      <AutoPlaySwitch />
    </View>
  );
}

/** Nothing queued (tablet, phone, native): one headline, one sentence. */
function EmptyQueue() {
  const { t } = useTranslation();
  return (
    <View className="mx-1.5 my-1 items-center gap-1 rounded-xl border-[1.5px] border-dashed border-border-strong px-4 py-6">
      <Text variant="label" className="text-center">
        {t('upnext.empty.title')}
      </Text>
      <Text variant="caption" className="text-center">
        {t('upnext.empty.hint')}
      </Text>
    </View>
  );
}

/** The loaded book: cover, title, chapter and time left at the listener's speed, and
 * play/pause. */
function NowPlayingCard({ nowPlaying }: { nowPlaying: NowPlaying }) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const chapter = usePlayer(selectCurrentChapter);
  const isPlaying = usePlayer(selectIsPlaying);
  const rate = usePlayer((s) => s.rate);
  const toggle = usePlayer((s) => s.toggle);
  const left = useBookTimeLeft(nowPlaying.queue.total);
  const where = [
    chapter ? chapterLabel(chapter, t) : '',
    left
      ? rate !== 1
        ? t('upnext.leftAtSpeed', { time: left, speed: rate })
        : t('shell.dock.bookLeft', { time: left })
      : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <View className="mx-1.5 mb-3 flex-row items-center gap-3 rounded-2xl bg-muted p-3">
      <BookCover
        connectionId={nowPlaying.connectionId}
        libraryId={nowPlaying.libraryId}
        path={nowPlaying.path}
        width={48}
        title={nowPlaying.title}
        author={nowPlaying.author}
      />
      <View className="flex-1 gap-0.5">
        <Text variant="eyebrow" className="text-[10.5px]">
          {t('upnext.nowPlaying')}
        </Text>
        <Text variant="label" className="text-[13.5px]" numberOfLines={1}>
          {nowPlaying.title}
        </Text>
        <Text variant="caption" numberOfLines={1}>
          {where}
        </Text>
      </View>
      <AnimatedPressable
        onPress={() => void toggle()}
        accessibilityRole="button"
        accessibilityLabel={isPlaying ? t('player.controls.pause') : t('player.controls.play')}
        className={cn(
          'h-11 w-11 items-center justify-center rounded-full active:bg-accent',
          Platform.select({
            web: `hover:bg-accent ${FOCUS_RING_CLASS}`,
          }),
        )}
      >
        <Icon name={isPlaying ? 'pause' : 'play'} size={16} color={themed.foreground} />
      </AnimatedPressable>
    </View>
  );
}

/** One "Continue the series and more" row: a book with a + to queue it, or the
 * series' next work this server doesn't have (a ghost that opens the series). */
function SuggestionRow({
  suggestion: s,
  cid,
  serverName,
  libraryId,
  onQueue,
  onNavigate,
}: {
  suggestion: Suggestion;
  cid: string;
  serverName: string;
  libraryId: number | undefined;
  onQueue: (libraryId: number, path: string) => void;
  onNavigate?: () => void;
}) {
  const { t } = useTranslation();
  const { openBook, openSeries } = useOpen();
  if (s.kind === 'ghost') {
    return (
      <View className="flex-row items-center gap-2.5 rounded-xl px-1.5 py-2">
        <GhostCover title={s.title} position={s.position} width={44} />
        <View className="flex-1 gap-0.5">
          <Text variant="label" className="text-[13px]" numberOfLines={2}>
            {serverName
              ? t('upnext.ghost', { title: s.title, server: serverName })
              : t('upnext.ghostNoServer', { title: s.title })}
          </Text>
          {libraryId !== undefined ? (
            <Button
              variant="link"
              size="sm"
              title={t('upnext.seeSeries')}
              onPress={() => {
                onNavigate?.();
                openSeries(cid, libraryId, { work: s.workId });
              }}
              className="self-start"
            />
          ) : null}
        </View>
      </View>
    );
  }
  return (
    <SuggestedBook
      cid={cid}
      libraryId={s.ref.library_id}
      path={s.ref.path}
      reason={
        s.kind === 'next'
          ? s.series
            ? t('upnext.nextInSeries', { series: s.series })
            : t('upnext.nextAfter')
          : t('upnext.continueAt', { percent: s.percent })
      }
      onOpen={() => {
        onNavigate?.();
        openBook(cid, s.ref.library_id, s.ref.path);
      }}
      onQueue={() => onQueue(s.ref.library_id, s.ref.path)}
    />
  );
}

function SuggestedBook({
  cid,
  libraryId,
  path,
  reason,
  onOpen,
  onQueue,
}: {
  cid: string;
  libraryId: number;
  path: string;
  reason: string;
  onOpen: () => void;
  onQueue: () => void;
}) {
  const { t } = useTranslation();
  const { data: book } = useBook(libraryId, path, cid);
  const title = bookTitle(book?.title, path);
  return (
    <View
      className={cn(
        'flex-row items-center gap-2.5 rounded-xl px-1.5 py-2',
        Platform.select({ web: 'hover:bg-muted' }),
      )}
    >
      <AnimatedPressable
        onPress={onOpen}
        accessibilityRole="button"
        accessibilityLabel={`${title}, ${reason}`}
        className="flex-1 flex-row items-center gap-2.5 rounded-lg"
      >
        <BookCover
          connectionId={cid}
          libraryId={libraryId}
          path={path}
          coverVersion={book?.cover_version}
          width={44}
          title={title}
          author={book?.author}
        />
        <View className="flex-1 gap-0.5">
          <Text variant="label" className="text-[13px]" numberOfLines={1}>
            {title}
          </Text>
          <Text variant="caption" numberOfLines={1}>
            {reason}
          </Text>
        </View>
      </AnimatedPressable>
      <Button
        variant="outline"
        size="icon"
        icon="plus"
        accessibilityLabel={t('upnext.add', { title })}
        onPress={onQueue}
        className="h-9 w-9"
      />
    </View>
  );
}

/** The existing auto-play setting, named for what it does today: the playback store
 * plays the next book in the series (or folder) when one ends; the queue is not played
 * yet. */
function AutoPlaySwitch() {
  const { t } = useTranslation();
  const on = useSettings((s) => s.autoPlayNext);
  const set = useSettings((s) => s.setAutoPlayNext);
  const label = t('upnext.autoPlay');
  return (
    <Pressable
      onPress={() => set(!on)}
      accessible={false}
      className="mt-3 flex-row items-center gap-2.5 px-2 py-2"
    >
      <Switch checked={on} onCheckedChange={set} accessibilityLabel={label} />
      <Text className="flex-1 text-[13px]">{label}</Text>
    </Pressable>
  );
}
