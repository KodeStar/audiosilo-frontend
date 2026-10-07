import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { useBook } from '@/api/hooks';
import type { Bookmark } from '@/api/types';
import { RowCover, ServerFlag, useChapterNamer, useJumpTo } from '@/components/annotations';
import { useServerFlag } from '@/components/library/cover-tile';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { getLocale } from '@/i18n/locale';
import { formatDayDate, formatDurationOrZero, formatWallClock } from '@/lib/format';
import {
  type ListeningSession,
  type ListeningSpan,
  sessionFinished,
  sessionMinutes,
} from '@/lib/listening-sessions';
import { useOpen } from '@/lib/open';
import { bookTitle } from '@/lib/paths';
import { useDayLabel } from '@/lib/use-day-label';
import { useNow } from '@/lib/use-now';
import { cn } from '@/lib/utils';
import { type DriftRecords, takeDrift } from '@/playback/drift';
import { tabularNums } from '@/theme/tabular-nums';
import { useThemeColors } from '@/theme/use-theme-colors';

import { barColor, type DiaryDay, dayBars, driftStrip, spanRange } from './diary-model';
import type { Sourced } from './merge-model';

/** The day's 24 hour bar: each span by wall clock, in its book's cover colour where it
 * stands off the track in this theme (else a quiet token, `barColor`), with hairlines at 06, 12 and 18. Decorative: one summary for screen
 * readers ("Listening across the day: 21:12 to 21:33, ..."). */
function DayBarView({ day }: { day: DiaryDay }) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const bars = dayBars(day);
  const summary = t('journal.diary.barLabel', {
    spans: [...day.sessions]
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
            backgroundColor: barColor(b.cover, themed.muted, themed.mutedForeground),
          }}
        />
      ))}
    </View>
  );
}

/** Spend a book's drift record as of now (never fails: a record that can't be taken just
 * stays until it goes stale). */
const spendDrift = (bookKey: string) => takeDrift(bookKey, Date.now()).catch(() => null);

/** The drift-off strip under a span the sleep timer ended: "You drifted off around
 * 23:41. Jump back 4 minutes?" with this device's record, else play from the bookmark.
 * The only part of the Diary that reads the clock (a record goes stale), so it is a
 * leaf of its own. */
function DriftStripView({
  span,
  bookmark,
  records,
}: {
  span: ListeningSpan;
  bookmark: Sourced<Bookmark>;
  records: DriftRecords;
}) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const jumpTo = useJumpTo();
  const now = useNow(60_000);
  const strip = driftStrip(bookmark, records, now);
  const time = formatWallClock(new Date(strip.at));
  const go = () => {
    const target = { connectionId: span.connectionId, libraryId: span.libraryId, path: span.path };
    if (strip.kind === 'resume') {
      jumpTo(target, strip.position);
      return;
    }
    // The record is spent by this jump, as by the player's own prompt: the book must not
    // ask "Jump back?" again once it starts there.
    void spendDrift(span.bookKey).then(() => jumpTo(target, strip.position));
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
        title={
          strip.kind === 'jumpBack'
            ? t('journal.diary.drift.jumpBackAction')
            : t('journal.diary.drift.resumeAction')
        }
        accessibilityHint={bookTitle(span.book?.title, span.path)}
        onPress={go}
      />
    </View>
  );
}

/** One listening session: cover, title, "21:12, 21 min" (its start and the minutes
 * listened), the chapters it went through (when this
 * device can know them), a drift-off strip, "Finished the book". The cover opens the
 * book page on its History tab. */
function SessionRow({
  session: span,
  drift,
  records,
  serverFlag,
}: {
  session: ListeningSession;
  drift?: Sourced<Bookmark>;
  records: DriftRecords;
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
  const nameAt = useChapterNamer(span);
  const title = bookTitle(book?.title, span.path);
  const when = t('journal.diary.when', {
    time: formatWallClock(new Date(span.start)),
    minutes: t('journal.minutes', { count: sessionMinutes(span) }),
  });
  return (
    <View className="flex-row items-start gap-3">
      <RowCover
        connectionId={span.connectionId}
        book={book ?? { library_id: span.libraryId, rel_path: span.path }}
        onOpen={() => openBook(span.connectionId, span.libraryId, span.path, 'history')}
        accessibilityLabel={t('journal.openBook', { title })}
      />
      <View className="min-w-0 flex-1 gap-0.5">
        <Text variant="body" className="text-[13px]" numberOfLines={2}>
          <Text className="font-sans-semibold text-[13px] text-foreground">{title}</Text>
          <Text className="text-[13px] text-muted-foreground" style={tabularNums}>
            {` · ${when}`}
          </Text>
        </Text>
        <Text variant="caption" numberOfLines={1} style={tabularNums}>
          {spanRange(span, nameAt, t)}
        </Text>
        {serverFlag ? <ServerFlag name={serverFlag} /> : null}
        {drift ? (
          <DriftStripView span={{ ...span, book }} bookmark={drift} records={records} />
        ) : null}
        {sessionFinished(span, book) ? (
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
 * sessions. Wide (measured): the name in a column beside the rest, as the prototype.
 * `today` is the day boundary (`useToday`): the card re-renders when the day moves on,
 * not every minute. */
export function DiaryDayCard({
  day,
  today,
  wide,
  drifts,
  records,
}: {
  day: DiaryDay;
  today: number;
  wide: boolean;
  drifts: Map<string, Sourced<Bookmark>>;
  records: DriftRecords;
}) {
  const label = useDayLabel();
  const serverFlag = useServerFlag();
  const date = formatDayDate(new Date(day.start), getLocale(), new Date(today));
  const name = label(day.start, today);
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
        {day.sessions.map((s) => (
          <SessionRow
            key={s.key}
            session={s}
            drift={drifts.get(s.key)}
            records={records}
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
