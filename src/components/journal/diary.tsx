import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';

import { useBook, useChapters } from '@/api/hooks';
import type { Bookmark } from '@/api/types';
import { BookCover } from '@/components/library/book-cover';
import { useServerFlag } from '@/components/library/cover-tile';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { formatDurationOrZero, formatWallClock } from '@/lib/format';
import { useOpen } from '@/lib/open';
import { bookTitle } from '@/lib/paths';
import { cn } from '@/lib/utils';
import { takeDrift } from '@/playback/drift';
import { tabularNums } from '@/theme/tabular-nums';
import { useThemeColors } from '@/theme/use-theme-colors';

import {
  chapterIndexOf,
  type DiaryDay,
  type DiarySpan,
  dayBars,
  dayName,
  type DriftStrip,
  reachedEnd,
  spanBookKey,
  spanMinutes,
  spanRange,
} from './diary-model';
import { formatDayDate, formatWeekday } from './journal-format';
import type { Sourced } from './merge-model';
import { useJumpTo } from './use-jump-to';

/** The day's name: Today, Yesterday, a weekday this week, else its date. */
export function useDayLabel() {
  const { t } = useTranslation();
  return (dayStart: number, now: number): string => {
    switch (dayName(dayStart, now)) {
      case 'today':
        return t('journal.diary.today');
      case 'yesterday':
        return t('journal.diary.yesterday');
      case 'weekday':
        return formatWeekday(new Date(dayStart));
      default:
        return formatDayDate(new Date(dayStart));
    }
  };
}

/** The day's 24 hour bar: each span by wall clock, in its book's cover accent (else a
 * quiet token), with hairlines at 06, 12 and 18. Decorative: one summary for screen
 * readers ("Listening across the day: 21:12 to 21:33, ..."). */
function DayBarView({ day }: { day: DiaryDay }) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const bars = dayBars(day);
  const summary = t('journal.diary.barLabel', {
    spans: [...day.spans]
      .sort((a, b) => a.start - b.start)
      .map((s) =>
        t('journal.diary.range', {
          from: formatWallClock(new Date(s.start)),
          to: formatWallClock(new Date(s.end)),
        }),
      )
      .join(', '),
  });
  return (
    <View
      accessible
      role="img"
      accessibilityLabel={summary}
      className="relative h-6 w-full overflow-hidden rounded-[6px] bg-muted"
    >
      {[0.25, 0.5, 0.75].map((x) => (
        <View
          key={x}
          className="absolute bottom-0 top-0 w-px bg-border-strong"
          style={{ left: `${x * 100}%` }}
        />
      ))}
      {bars.map((b) => (
        <View
          key={b.key}
          className="absolute top-[5px] h-3.5 rounded-[3px]"
          style={{
            left: `${b.left * 100}%`,
            width: `${b.width * 100}%`,
            backgroundColor: b.color ?? themed.mutedForeground,
          }}
        />
      ))}
    </View>
  );
}

/** The drift-off strip under a span the sleep timer ended: "You drifted off around
 * 23:41. Jump back 4 minutes?" with this device's record, else play from the bookmark. */
function DriftStripView({ span, strip }: { span: DiarySpan; strip: DriftStrip }) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const jumpTo = useJumpTo();
  const [busy, setBusy] = useState(false);
  const time = formatWallClock(new Date(strip.at));
  const title = bookTitle(span.book?.title, span.path);
  const go = () => {
    setBusy(true);
    const target = {
      connectionId: span.connectionId,
      libraryId: span.libraryId,
      path: span.path,
    };
    // The record is spent by this jump, as by the player's own prompt: the book must not
    // ask "Jump back?" again once it starts there.
    const spend =
      strip.kind === 'jumpBack' ? takeDrift(spanBookKey(span), Date.now()) : Promise.resolve();
    void spend
      .catch(() => null)
      .then(() => jumpTo(target, strip.position))
      .catch(() => toast({ title: t('journal.jumpFailed', { title }) }))
      .finally(() => setBusy(false));
  };
  return (
    <View className="mt-1.5 flex-row flex-wrap items-center gap-x-2.5 gap-y-2 rounded-control bg-brand-soft px-3 py-2">
      <Icon name="sleep" size={15} color={themed.brandInk} />
      <Text variant="caption" className="min-w-[160px] flex-1 text-brand-ink">
        {strip.kind === 'jumpBack'
          ? t('journal.diary.drift.jumpBack', { time, count: strip.minutes })
          : t('journal.diary.drift.resume', { time })}
      </Text>
      <Button
        variant="outline"
        size="sm"
        loading={busy}
        title={
          strip.kind === 'jumpBack'
            ? t('journal.diary.drift.jumpBackAction')
            : t('journal.diary.drift.resumeAction')
        }
        accessibilityHint={title}
        onPress={go}
      />
    </View>
  );
}

/** One span: cover, title, "21:12, 21 min", the chapters it went through (when this
 * device can know them), a drift-off strip, "Finished the book". The cover opens the
 * book page on its History tab. */
function SpanRow({
  span,
  drift,
  driftStripFor,
  serverFlag,
}: {
  span: DiarySpan;
  drift?: Sourced<Bookmark>;
  driftStripFor: (bookmark: Sourced<Bookmark>) => DriftStrip;
  serverFlag?: string;
}) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const { openBook } = useOpen();
  // An older server sends no `book` with its history: read the item (cached per book).
  const item = useBook(span.libraryId, span.path, span.connectionId, {
    enabled: !span.book,
  }).data;
  const book = span.book ?? item;
  // The chapters, once per book (shared with its page and the player through
  // `qk.chapters`): rows show where the listening went, by name. Until they come (or
  // when they can't), the positions.
  const chapters = useChapters(span.libraryId, span.path, span.connectionId).data;
  const index = useMemo(() => chapterIndexOf(chapters?.chapters, chapters?.files), [chapters]);
  const title = bookTitle(book?.title, span.path);
  const when = t('journal.diary.when', {
    time: formatWallClock(new Date(span.start)),
    minutes: t('journal.minutes', { count: spanMinutes(span) }),
  });
  return (
    <View className="flex-row items-start gap-3">
      <AnimatedPressable
        onPress={() => openBook(span.connectionId, span.libraryId, span.path, 'history')}
        accessibilityRole="link"
        accessibilityLabel={t('journal.openBook', { title })}
        className={cn('rounded-cover', Platform.select({ web: 'cursor-pointer' }))}
      >
        <BookCover
          connectionId={span.connectionId}
          libraryId={span.libraryId}
          path={span.path}
          coverVersion={book?.cover_version}
          width={40}
          title={title}
          author={book?.author}
        />
      </AnimatedPressable>
      <View className="min-w-0 flex-1 gap-0.5">
        <Text variant="body" className="text-[13px]" numberOfLines={2}>
          <Text className="font-sans-semibold text-[13px] text-foreground">{title}</Text>
          <Text className="text-[13px] text-muted-foreground" style={tabularNums}>
            {` · ${when}`}
          </Text>
        </Text>
        <Text variant="caption" numberOfLines={1} style={tabularNums}>
          {spanRange(span, index, t)}
        </Text>
        {serverFlag ? (
          <View className="flex-row items-center gap-1">
            <Icon name="server" size={11} color={themed.info} />
            <Text variant="caption" className="text-info" numberOfLines={1}>
              {serverFlag}
            </Text>
          </View>
        ) : null}
        {drift ? <DriftStripView span={{ ...span, book }} strip={driftStripFor(drift)} /> : null}
        {reachedEnd({ to: span.to, book }) ? (
          <Badge variant="success" className="mt-1.5 self-start">
            <Icon name="circle-check" size={12} color={themed.success} />
            <Text>{t('journal.diary.finished')}</Text>
          </Badge>
        ) : null}
      </View>
    </View>
  );
}

/** One day of the Diary, on its own card: the name and total, the 24 hour bar, the
 * spans. Wide (measured): the name in a column beside the rest, as the prototype. */
export function DiaryDayCard({
  day,
  now,
  wide,
  drifts,
  driftStripFor,
}: {
  day: DiaryDay;
  now: number;
  wide: boolean;
  drifts: Map<string, Sourced<Bookmark>>;
  driftStripFor: (bookmark: Sourced<Bookmark>) => DriftStrip;
}) {
  const label = useDayLabel();
  const serverFlag = useServerFlag();
  const date = formatDayDate(new Date(day.start));
  const name = label(day.start, now);
  return (
    <Card className={cn('gap-4 p-4', wide && 'flex-row gap-6 p-5')}>
      <View className={cn('gap-0.5', wide && 'w-[120px]')}>
        <Text variant="title" className="text-[17px]" accessibilityRole="header">
          {name}
        </Text>
        <Text variant="caption" style={tabularNums}>
          {name === date
            ? formatDurationOrZero(day.total)
            : `${date} · ${formatDurationOrZero(day.total)}`}
        </Text>
      </View>
      <View className="min-w-0 flex-1 gap-3">
        <DayBarView day={day} />
        {day.spans.map((s) => (
          <SpanRow
            key={s.key}
            span={s}
            drift={drifts.get(s.key)}
            driftStripFor={driftStripFor}
            serverFlag={serverFlag(s.connectionId)}
          />
        ))}
      </View>
    </Card>
  );
}

/** The Diary's loading state: two day-shaped cards. */
export function DiarySkeleton() {
  return (
    <View className="gap-4" testID="diary-skeleton">
      {[0, 1].map((i) => (
        <Card key={i} className="gap-3 p-4">
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-6 w-full rounded-[6px]" />
          {[0, 1].map((r) => (
            <View key={r} className="flex-row items-center gap-3">
              <Skeleton className="h-10 w-10 rounded-cover" />
              <View className="flex-1 gap-1.5">
                <Skeleton className="h-3.5 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
              </View>
            </View>
          ))}
        </Card>
      ))}
    </View>
  );
}
