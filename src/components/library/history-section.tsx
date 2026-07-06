import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { useHistory } from '@/api/hooks';
import { useCid } from '@/api/provider';
import type { Chapter } from '@/api/types';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { EmptyState } from '@/components/ui/empty-state';
import { Icon } from '@/components/ui/icon';
import { SectionHeader } from '@/components/ui/section-header';
import { Text } from '@/components/ui/text';
import { formatClock, formatDuration } from '@/lib/format';
import { chapterAt } from '@/playback/book-queue';
import { colors, tabularNums } from '@/theme/tokens';

/** Recent listening spans for a book. Each span shows its START (▶) and END (⏸)
 * positions, both independently tappable, so you can jump to either - the end is
 * "where I left off" (handy recovery), the start replays the span. When `chapters`
 * (carrying whole-book offsets) are supplied, each position is also labelled with
 * its chapter, which is far easier to read than a raw timestamp. The footer shows
 * how long the session ran and its effective speed (content covered / wall time).
 * Renders nothing when there's no history. */
export function HistorySection({
  libraryId,
  path,
  connectionId,
  emptyLabel,
  chapters,
  hideHeader,
}: {
  libraryId: number;
  path: string;
  /** Source connection; defaults to the active one. The player passes the playing
   * book's connection so history addresses the right server. */
  connectionId?: string;
  emptyLabel?: string;
  chapters?: Chapter[];
  /** Suppress the internal heading when the caller supplies one (the player sheet's
   * own title bar), so the sheet doesn't show two stacked headings. */
  hideHeader?: boolean;
}) {
  const { t } = useTranslation();
  const { data: history } = useHistory(libraryId, path, connectionId);
  // The book's own connection: passed in (player sheet) or the route scope (book
  // screen). The player carries it as a param.
  const cid = useCid(connectionId);

  if (!history || history.length === 0) {
    // Inline (book screen) hides entirely when empty; the player sheet passes an
    // emptyLabel so the sheet visibly opens instead of showing a blank panel.
    if (!emptyLabel) return null;
    return (
      <View className="gap-2">
        {hideHeader ? null : <SectionHeader title={t('library.history.title')} />}
        <EmptyState icon="history" title={emptyLabel} className="py-6" />
      </View>
    );
  }

  const jump = (position: number) =>
    router.push({
      pathname: '/player',
      params: { connection: cid, libraryId: String(libraryId), path, position: String(position) },
    });

  const labelAt = (pos: number): string => {
    const c = chapters && chapters.length > 0 ? chapterAt(chapters, pos) : null;
    const name = c ? c.title || t('player.chapters.chapterNumber', { number: c.index + 1 }) : null;
    return name ? `${formatClock(pos)} · ${name}` : formatClock(pos);
  };

  return (
    <View className="gap-2">
      {hideHeader ? null : <SectionHeader title={t('library.history.title')} />}
      {history.map((h) => {
        const wall = Math.max(0, (Date.parse(h.ended_at) - Date.parse(h.started_at)) / 1000);
        const covered = Math.max(0, h.to_pos - h.from_pos);
        const speed = wall > 0 ? covered / wall : 0;
        return (
          <View
            key={h.id}
            className="gap-1.5 rounded-xl bg-white p-3 shadow-sm dark:border dark:border-gray-750 dark:bg-gray-840 dark:shadow-none"
          >
            <View className="flex-row items-center gap-2">
              <Icon name="clock" size={13} color={colors.primary} />
              <Text variant="caption" style={tabularNums}>
                {new Date(h.started_at).toLocaleString()}
              </Text>
            </View>
            {/* End (⏸, where you left off) above start (▶), so reading top-to-bottom
                matches the most-recent-first ordering of the list itself. */}
            <AnimatedPressable
              onPress={() => jump(h.to_pos)}
              className="flex-row items-center gap-2 py-0.5"
              accessibilityRole="button"
            >
              <Icon name="pause" size={13} color={colors.primary} />
              <Text variant="subtitle" numberOfLines={1} className="flex-1" style={tabularNums}>
                {labelAt(h.to_pos)}
              </Text>
            </AnimatedPressable>
            <AnimatedPressable
              onPress={() => jump(h.from_pos)}
              className="flex-row items-center gap-2 py-0.5"
              accessibilityRole="button"
            >
              <Icon name="play" size={13} />
              <Text variant="subtitle" numberOfLines={1} className="flex-1" style={tabularNums}>
                {labelAt(h.from_pos)}
              </Text>
            </AnimatedPressable>
            {wall > 0 ? (
              <Text variant="caption" style={tabularNums}>
                {t('book.duration', { value: formatDuration(wall) })}
                {speed > 0 ? ` · ${Number(speed.toFixed(2))}×` : ''}
              </Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}
