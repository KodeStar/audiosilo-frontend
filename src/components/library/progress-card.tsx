import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, useWindowDimensions, View } from 'react-native';

import { useMarkFinished, type SourcedProgress } from '@/api/hooks';
import { useApi } from '@/api/provider';
import { GridCard } from '@/components/library/poster-grid';
import { Icon } from '@/components/ui/icon';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { contentKey } from '@/lib/content-key';
import { formatDuration } from '@/lib/format';
import { WIDE_BREAKPOINT } from '@/lib/layout';
import { useOpen } from '@/lib/open';
import { parentPath, pathLeaf } from '@/lib/paths';
import { progressFractionRemaining } from '@/lib/progress-view';
import { selectBookPosition, usePlayer } from '@/playback/store';
import { useTheme } from '@/theme/theme-provider';
import { colors } from '@/theme/tokens';

/** Stable list key for a progress entry across connections. */
export const progressKey = (it: SourcedProgress) =>
  contentKey(it.connectionId, it.library_id, it.path);

/** Overflow menu for an in-progress book: mark finished, or jump to the
 * containing folder ("more in series"). Presented as a bottom Sheet. */
function ProgressMenu({ item }: { item: SourcedProgress }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const markFinished = useMarkFinished(item.connectionId);
  const { openLibrary } = useOpen();
  const { scheme } = useTheme();
  const neutral = scheme === 'dark' ? colors.dark.text : colors.light.textMuted;

  const onMarkFinished = () => {
    setOpen(false);
    markFinished.mutate({
      libraryId: item.library_id,
      path: item.path,
      position: item.position,
      duration: item.duration,
      playback_speed: item.playback_speed,
    });
  };
  const onMoreInSeries = () => {
    setOpen(false);
    void openLibrary(item.connectionId, item.library_id, parentPath(item.path));
  };

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        hitSlop={8}
        className="h-8 w-8 items-center justify-center rounded-full active:opacity-60"
        accessibilityRole="button"
        accessibilityLabel={t('library.progressCard.moreActions')}
      >
        <Icon name="ellipsis" size={20} color={neutral} />
      </Pressable>

      <Sheet visible={open} onClose={() => setOpen(false)} title={pathLeaf(item.path)}>
        <View className="gap-1 px-2 pb-4 pt-1">
          <MenuRow
            icon="check"
            label={t('library.progressCard.markFinished')}
            onPress={onMarkFinished}
          />
          <MenuRow
            icon="library"
            label={t('library.progressCard.moreInSeries')}
            onPress={onMoreInSeries}
          />
        </View>
      </Sheet>
    </>
  );
}

function MenuRow({
  icon,
  label,
  onPress,
}: {
  icon: 'check' | 'library';
  label: string;
  onPress: () => void;
}) {
  const { scheme } = useTheme();
  const neutral = scheme === 'dark' ? colors.dark.textStrong : colors.light.textStrong;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      className="flex-row items-center gap-3 rounded-lg px-4 py-3 active:bg-gray-200 dark:active:bg-gray-860"
    >
      <Icon name={icon} size={20} color={neutral} />
      <Text variant="title">{label}</Text>
    </Pressable>
  );
}

/** A poster card for an in-progress / finished book, with a live-updating progress
 * bar and "time left". Shared by the Home shelves and the /browse page. */
export function ProgressCard({ item, width }: { item: SourcedProgress; width: number }) {
  const { t } = useTranslation();
  const api = useApi(item.connectionId);
  const { openBook, openPlayer } = useOpen();
  const { width: screenWidth } = useWindowDimensions();
  const wide = screenWidth >= WIDE_BREAKPOINT;

  // For the book loaded in the player right now, read the live whole-book position
  // from the store so "time left" ticks in real time instead of showing the stale
  // last-saved value. The selector returns the constant `item.position` for every
  // other card, so only the active card re-renders as playback advances.
  const position = usePlayer((s) => {
    const np = s.nowPlaying;
    const isThis =
      np?.connectionId === item.connectionId &&
      np?.libraryId === item.library_id &&
      np?.path === item.path;
    return isThis ? selectBookPosition(s) : item.position;
  });
  const { fraction, remaining } = progressFractionRemaining(position, item.duration);

  // On phone open the full-screen player modal (scoped to this item's connection),
  // or on desktop resume in the persistent player panel (fetch via the item's
  // connection, start playback). The connection travels in the route, so there is
  // no active-connection flip.
  const play = async () => {
    if (!wide) {
      // Land on the book page underneath the player (like tapping the cover does),
      // so closing the player returns there instead of back to Home.
      openBook(item.connectionId, item.library_id, item.path);
      openPlayer(item.connectionId, item.library_id, item.path);
      return;
    }
    const current = usePlayer.getState().nowPlaying;
    if (
      current?.connectionId === item.connectionId &&
      current?.libraryId === item.library_id &&
      current?.path === item.path
    )
      return;
    const [book, chapterData] = await Promise.all([
      api.item(item.library_id, item.path),
      api.chapters(item.library_id, item.path),
    ]);
    await usePlayer.getState().playBook(item.connectionId, item.library_id, book, chapterData);
  };

  return (
    <GridCard
      libraryId={item.library_id}
      path={item.path}
      title={pathLeaf(item.path)}
      connectionId={item.connectionId}
      width={width}
      footer={
        !item.finished ? (
          <View className="gap-1.5">
            <View className="flex-row items-center gap-2.5">
              <View className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-300 dark:bg-gray-750">
                <View
                  className="h-full rounded-full bg-primary"
                  style={{ width: `${fraction * 100}%` }}
                />
              </View>
              <Pressable
                onPress={() => void play()}
                hitSlop={8}
                className="h-9 w-9 items-center justify-center rounded-full bg-primary pl-0.5 active:opacity-80"
                accessibilityRole="button"
                accessibilityLabel={t('library.progressCard.resume')}
              >
                <Icon name="play" size={15} color={colors.white} />
              </Pressable>
              <ProgressMenu item={item} />
            </View>
            {remaining > 0 ? (
              <Text variant="caption" style={{ fontVariant: ['tabular-nums'] }}>
                {t('library.progressCard.timeLeft', { duration: formatDuration(remaining) })}
              </Text>
            ) : null}
          </View>
        ) : (
          <View className="flex-row items-center gap-1.5">
            <Icon name="check" size={13} color={colors.primary} />
            <Text variant="caption">{t('library.progressCard.finished')}</Text>
          </View>
        )
      }
    />
  );
}
