import { router } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, Pressable, useWindowDimensions, View } from 'react-native';

import { useMarkFinished, type SourcedProgress } from '@/api/hooks';
import { useApi } from '@/api/provider';
import { GridCard } from '@/components/library/poster-grid';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { formatDuration } from '@/lib/format';
import { useOpen } from '@/lib/open';
import { bookHref, parentPath, pathLeaf } from '@/lib/paths';
import { progressFractionRemaining } from '@/lib/progress-view';
import { selectBookPosition, usePlayer } from '@/playback/store';
import { useSession } from '@/stores/session';
import { useTheme } from '@/theme/theme-provider';
import { colors } from '@/theme/tokens';

const WIDE_BREAKPOINT = 1024;

/** Stable list key for a progress entry across connections. */
export const progressKey = (it: SourcedProgress) =>
  `${it.connectionId}:${it.library_id}:${it.path}`;

/** Overflow menu for an in-progress book: mark finished, or jump to the
 * containing folder ("more in series"). */
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
      <Pressable onPress={() => setOpen(true)} hitSlop={8} className="px-1 active:opacity-60">
        <Icon name="ellipsis" size={22} color={neutral} />
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable className="flex-1 justify-end bg-black/40" onPress={() => setOpen(false)}>
          <Pressable
            className="gap-1 rounded-t-2xl bg-gray-100 p-2 pb-6 dark:bg-gray-840"
            onPress={() => {}}
          >
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
          </Pressable>
        </Pressable>
      </Modal>
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
  const setActive = useSession((s) => s.setActiveConnection);
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

  // Make this item's server active first (so the player chrome reads from it),
  // then on phone open the full-screen player modal, or on desktop resume in the
  // persistent player panel (fetch via the item's connection, start playback).
  const play = async () => {
    await setActive(item.connectionId);
    if (!wide) {
      // Land on the book page underneath the player (like tapping the cover does),
      // so closing the player returns there instead of back to Home.
      router.push(bookHref(item.library_id, item.path));
      router.push({
        pathname: '/player',
        params: { libraryId: String(item.library_id), path: item.path },
      });
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
    await usePlayer.getState().playBook(api, item.connectionId, item.library_id, book, chapterData);
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
          <View className="gap-1">
            <View className="flex-row items-center gap-2">
              <View className="h-1 flex-1 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
                <View
                  className="h-full rounded-full bg-primary"
                  style={{ width: `${fraction * 100}%` }}
                />
              </View>
              <Pressable onPress={() => void play()} hitSlop={8} className="active:opacity-60">
                <Icon name="circle-play" size={26} color={colors.primary} />
              </Pressable>
              <ProgressMenu item={item} />
            </View>
            {remaining > 0 ? (
              <Text variant="caption">
                {t('library.progressCard.timeLeft', { duration: formatDuration(remaining) })}
              </Text>
            ) : null}
          </View>
        ) : (
          <Text variant="caption">{t('library.progressCard.finished')}</Text>
        )
      }
    />
  );
}
