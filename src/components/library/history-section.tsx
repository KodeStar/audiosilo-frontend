import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { useHistory } from '@/api/hooks';
import { useCid } from '@/api/provider';
import type { Chapter } from '@/api/types';
import { chapterNamer, useJumpTo } from '@/components/annotations';
import {
  type DiarySpan,
  dayName,
  localDayStart,
  groupSessions,
  sessionMinutes,
  toSpan,
} from '@/components/journal/diary-model';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { RowSkeletonList } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { formatClock, formatShortDay, formatWallClock } from '@/lib/format';
import { useNow } from '@/lib/use-now';
import { cn } from '@/lib/utils';
import { tabularNums } from '@/theme/tabular-nums';

/**
 * A book's listening sessions (its history's spans joined across pauses, `groupSessions`;
 * the book page's History tab and the player companion's;
 * Stacks prototype `HistoryPanel`), newest first, one row each: the day and the time it
 * started, where it went in the book ("17:00:00 to 17:25:42 · Bridge Four", the chapter
 * at its end, when `chapters` with whole-book offsets are given), the minutes listened, and
 * Jump to where it ended. The rows read the Journal's diary model, so the two agree. No
 * speed or device: a history row carries neither.
 *
 * Inline on the book screen it renders nothing when empty; a caller that passes
 * `emptyLabel` (the tabs, the companion) gets an empty state, a loading skeleton and a
 * failed-load note instead.
 */
export function HistorySection({
  libraryId,
  path,
  connectionId,
  emptyLabel,
  chapters,
  onJump,
}: {
  libraryId: number;
  path: string;
  /** Source connection; defaults to the active one. The player passes the playing
   * book's connection so history addresses the right server. */
  connectionId?: string;
  emptyLabel?: string;
  chapters?: Chapter[];
  /** Where a tap on Jump goes (the companion seeks the playing book in place); without
   * it, the shared jump (`useJumpTo`: the player on a phone, in place elsewhere). */
  onJump?: (position: number) => void;
}) {
  const { t } = useTranslation();
  const { data: history, isError, refetch } = useHistory(libraryId, path, connectionId);
  // The book's own connection: passed in (player sheet) or the route scope (book
  // screen). The player carries it as a param.
  const cid = useCid(connectionId);
  const now = useNow(60_000);
  const jumpTo = useJumpTo();

  if (!history || history.length === 0) {
    if (!emptyLabel) return null;
    if (!history) {
      return isError ? (
        <EmptyState
          icon="circle-exclamation"
          title={t('journal.diary.error.title')}
          action={{ label: t('common.retry'), onPress: () => void refetch() }}
          className="py-6"
        />
      ) : (
        <RowSkeletonList count={3} />
      );
    }
    return <EmptyState icon="history" title={emptyLabel} className="py-6" />;
  }

  const jump = (position: number) =>
    onJump ? onJump(position) : jumpTo({ connectionId: cid, libraryId, path }, position);
  const nameAt = chapterNamer(chapters, undefined, t);
  // One row per listening session (the server records a span per pause), as the Diary.
  const sessions = groupSessions(
    history
      .map((h) => toSpan({ ...h, connectionId: cid, connectionName: '' }))
      .filter((s): s is DiarySpan => s !== null),
  );

  const day = (s: DiarySpan) => {
    const name = dayName(localDayStart(s.start), now);
    if (name === 'today') return t('journal.diary.today');
    if (name === 'yesterday') return t('journal.diary.yesterday');
    return formatShortDay(new Date(s.start));
  };

  return (
    <View className="overflow-hidden rounded-card border border-border bg-card">
      {sessions.map((s, i) => {
        const range = t('journal.history.span', {
          from: formatClock(s.from),
          to: formatClock(s.to),
        });
        const chapter = nameAt(s.to);
        const where = chapter ? `${range} · ${chapter}` : range;
        return (
          <View
            key={s.key}
            className={cn(
              'flex-row items-center gap-3 px-4 py-3',
              i > 0 && 'border-t border-border',
            )}
          >
            <View className="w-[84px] gap-0.5">
              <Text variant="label" numberOfLines={1}>
                {day(s)}
              </Text>
              <Text variant="caption" style={tabularNums}>
                {formatWallClock(new Date(s.start))}
              </Text>
            </View>
            <View className="min-w-0 flex-1 gap-0.5">
              <Text className="text-[13px]" style={tabularNums} numberOfLines={2}>
                {where}
              </Text>
              <Text variant="caption" style={tabularNums}>
                {t('journal.minutes', { count: sessionMinutes(s) })}
              </Text>
            </View>
            <Button
              variant="ghost"
              size="sm"
              title={t('journal.history.jump')}
              accessibilityLabel={t('journal.history.jumpLabel', { time: formatClock(s.to) })}
              onPress={() => jump(s.to)}
            />
          </View>
        );
      })}
    </View>
  );
}
