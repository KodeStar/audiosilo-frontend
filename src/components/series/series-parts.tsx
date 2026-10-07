import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';
import Svg, { Line } from 'react-native-svg';

import { BookCover } from '@/components/library/book-cover';
import { GhostCover } from '@/components/library/ghost-cover';
import { Icon } from '@/components/ui/icon';
import { ProgressBar } from '@/components/ui/progress-bar';
import { Text } from '@/components/ui/text';
import { formatDuration } from '@/lib/format';
import { useLayout } from '@/lib/layout';
import { useOpen } from '@/lib/open';
import { percentOf } from '@/lib/progress-view';
import { cn } from '@/lib/utils';
import { tabularNums } from '@/theme/tabular-nums';
import { useThemeColors } from '@/theme/use-theme-colors';

import { EntryActionButton, EntryBadge } from './entry-actions';
import type { SeriesEntry, SeriesStats, TrackSegment } from './series-model';
import { RIBBON_WIDTH } from './spine';

/** Diagonal hatching for a missing segment or swatch (decorative). */
function Hatch({ color }: { color: string }) {
  const gap = 4;
  return (
    <Svg width={600} height={40} style={{ position: 'absolute', left: 0, top: 0 }}>
      {Array.from({ length: Math.ceil(640 / gap) }, (_, i) => (
        <Line
          key={i}
          x1={i * gap}
          y1={0}
          x2={i * gap - 40}
          y2={40}
          stroke={color}
          strokeWidth={1}
          strokeOpacity={0.8}
        />
      ))}
    </Svg>
  );
}

/**
 * The series' segmented progress track (STYLEGUIDE section 8, "Series shelf"): one
 * segment per entry, as wide as its spine would be, green when finished, pink as far as
 * you've listened, hatched when the book is on no server, beside the words that say the
 * same ("38% into book 1 · 262h of listening ahead"), which are its accessible name.
 */
export function ProgressTrack({
  segments,
  label,
}: {
  segments: readonly TrackSegment[];
  label: string;
}) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  return (
    <View
      className="flex-row flex-wrap items-center gap-x-3.5 gap-y-2"
      accessible
      accessibilityRole="text"
      accessibilityLabel={`${t('series.progress.label')}: ${label}`}
    >
      <View
        className="h-2.5 min-w-[220px] flex-1 flex-row"
        style={{ gap: 3 }}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {segments.map((s) => (
          <View
            key={s.key}
            style={{ flex: s.flex }}
            className={cn(
              'overflow-hidden rounded-[3px]',
              s.state === 'finished' && 'bg-success',
              (s.state === 'partial' || s.state === 'unread') && 'bg-muted-foreground/20',
              s.state === 'missing' && 'border border-border-strong',
            )}
          >
            {s.state === 'missing' ? <Hatch color={themed.borderStrong} /> : null}
            {s.state === 'partial' ? (
              <View className="h-full bg-brand" style={{ width: `${s.fraction * 100}%` }} />
            ) : null}
          </View>
        ))}
      </View>
      <Text variant="muted" className="text-foreground" style={tabularNums}>
        {label}
      </Text>
    </View>
  );
}

/** "Book 2 · 2012 · 2h 30m": an entry's eyebrow, leaving out what isn't known. */
function entryFacts(entry: SeriesEntry, t: TFunction): string {
  return [
    entry.position ? t('series.bookN', { position: entry.position }) : '',
    entry.year ?? '',
    formatDuration(entry.seconds),
  ]
    .filter(Boolean)
    .join(' · ');
}

/** The words under a face-out book: who reads it, or where it is, or that it is on no
 * server yet. */
function entryNote(entry: SeriesEntry, here: string, t: TFunction) {
  if (entry.kind === 'owned') {
    return entry.narrator ? t('series.readBy', { narrator: entry.narrator }) : '';
  }
  if (entry.kind === 'elsewhere') {
    return t('series.elsewhereNote', { here, server: entry.copy.connectionName });
  }
  return entry.title ? t('series.ghostNote') : t('series.gapNote');
}

/**
 * The caption under the bookcase's plank for the face-out book: book number, year and
 * length, its title and status, a line about who reads it or where it is, and its ONE
 * action (`EntryActionButton`).
 */
export function ShelfCaption({
  entry,
  current,
  here,
  resumeChapter,
}: {
  entry: SeriesEntry;
  current: boolean;
  /** This connection's name ("Not on Home Library, but ..."). */
  here: string;
  resumeChapter?: number;
}) {
  const { t } = useTranslation();
  const wide = useLayout() !== 'phone';
  const note = entryNote(entry, here, t);
  return (
    <View
      className={cn('gap-3.5 pb-1 pt-4', wide && 'flex-row items-center justify-between gap-6')}
    >
      <View className="min-w-0 shrink gap-1.5">
        <Text variant="eyebrow" style={tabularNums}>
          {entryFacts(entry, t)}
        </Text>
        <View className="flex-row flex-wrap items-center gap-x-2.5 gap-y-1">
          <Text
            className={cn(
              'font-display tracking-tight text-foreground',
              wide ? 'text-[26px] leading-[28px]' : 'text-[21px] leading-[24px]',
            )}
            accessibilityRole="header"
          >
            {entry.title ?? t('covers.bookNumber', { position: entry.position })}
          </Text>
          <EntryBadge entry={entry} current={current} />
        </View>
        {note ? <Text variant="muted">{note}</Text> : null}
      </View>
      <EntryActionButton entry={entry} resumeChapter={current ? resumeChapter : undefined} />
    </View>
  );
}

/** What the bookcase's marks mean, for the kinds this shelf shows (decorative marks,
 * so each item is read by its words). */
export function ShelfLegend({
  entries,
  hasCurrent,
}: {
  entries: readonly SeriesEntry[];
  hasCurrent: boolean;
}) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const kinds = new Set(entries.map((e) => e.kind));
  const items = [
    kinds.has('owned') && {
      key: 'owned',
      mark: <View className="h-[18px] w-[9px] rounded-[2px] bg-primary" />,
      label: t('series.legend.owned'),
    },
    kinds.has('elsewhere') && {
      key: 'elsewhere',
      mark: (
        <View className="h-[18px] w-[9px] rounded-[2px] border-[1.5px] border-dashed border-info" />
      ),
      label: t('series.legend.elsewhere'),
    },
    kinds.has('ghost') && {
      key: 'ghost',
      mark: (
        <View className="h-[18px] w-[9px] overflow-hidden rounded-[2px] border-[1.5px] border-dashed border-subtle-foreground">
          <Hatch color={themed.borderStrong} />
        </View>
      ),
      label: t('series.legend.ghost'),
    },
    hasCurrent && {
      key: 'current',
      mark: (
        <View className="h-[18px] rounded-t-[1px] bg-brand" style={{ width: RIBBON_WIDTH - 2 }} />
      ),
      label: t('series.legend.current'),
    },
  ].filter((x): x is { key: string; mark: React.ReactElement; label: string } => !!x);
  if (items.length < 2) return null;
  return (
    <View className="flex-row flex-wrap gap-x-[18px] gap-y-1.5 pb-6 pt-3">
      {items.map((it) => (
        <View key={it.key} className="flex-row items-center gap-[7px]">
          {it.mark}
          <Text variant="caption">{it.label}</Text>
        </View>
      ))}
    </View>
  );
}

/** The entry list's number: 22 (18 on a phone), smaller for "0.5" and "12.25" so it
 * fits its column. */
function numberSize(position: string, phone: boolean): number {
  const n = position.length;
  if (phone) return n >= 4 ? 12 : n === 3 ? 15 : 18;
  return n >= 4 ? 16 : n === 3 ? 19 : 22;
}

/** "2014 · 6h 17m · 40%": an entry's line in the list. */
function entryLine(entry: SeriesEntry, t: TFunction): string {
  const state = entry.finished
    ? t('covers.finished')
    : entry.kind === 'elsewhere'
      ? t('covers.onServer', { server: entry.copy.connectionName })
      : entry.kind === 'ghost'
        ? t('covers.notInLibrary')
        : entry.fraction > 0
          ? `${percentOf(entry.fraction)}%`
          : '';
  return [entry.year ?? '', formatDuration(entry.seconds), state].filter(Boolean).join(' · ');
}

/**
 * The series as a list, in the shown reading order (the prototype's entry list): the
 * number, the cover (or a ghost), the title, year, length and where you are, and the
 * entry's action. A row with a copy opens it.
 */
export function EntryList({
  entries,
  currentKey,
}: {
  entries: readonly SeriesEntry[];
  currentKey?: string;
}) {
  const { t } = useTranslation();
  const phone = useLayout() === 'phone';
  const { openBook } = useOpen();
  const cover = phone ? 56 : 72;
  return (
    <View>
      {entries.map((e, i) => {
        const current = e.key === currentKey;
        const copy = e.copy;
        const title = e.title ?? t('covers.bookNumber', { position: e.position });
        const line = entryLine(e, t);
        const body = (
          <>
            <Text
              className={cn(
                'text-center font-display tracking-tight',
                current ? 'text-brand-ink' : 'text-subtle-foreground',
              )}
              style={[
                { width: phone ? 34 : 48, fontSize: numberSize(e.position, phone) },
                tabularNums,
              ]}
              numberOfLines={1}
            >
              {e.position}
            </Text>
            {copy ? (
              <BookCover
                connectionId={copy.connectionId}
                libraryId={copy.libraryId}
                path={copy.path}
                coverVersion={e.coverVersion}
                width={cover}
                title={title}
                author={copy.book?.author}
              />
            ) : (
              <GhostCover title={title} position={e.title ? e.position : undefined} width={cover} />
            )}
            <View className="min-w-0 flex-1 gap-0.5">
              <Text variant="label" className="text-[15px]" numberOfLines={2}>
                {title}
              </Text>
              {line ? (
                <Text variant="caption" style={tabularNums} numberOfLines={1}>
                  {line}
                </Text>
              ) : null}
              {current ? (
                <ProgressBar fraction={e.fraction} className="mt-1.5 max-w-[280px]" />
              ) : null}
            </View>
          </>
        );
        const label = [title, line].filter(Boolean).join(', ');
        return (
          <View
            key={e.key}
            className={cn('gap-2 py-3.5', i > 0 && 'border-t border-border')}
            role="listitem"
          >
            <View className="flex-row items-center gap-3">
              {copy ? (
                <Pressable
                  onPress={() => openBook(copy.connectionId, copy.libraryId, copy.path)}
                  accessibilityRole="button"
                  accessibilityLabel={label}
                  className="min-w-0 flex-1 flex-row items-center gap-3 rounded-md active:opacity-80 md:gap-4"
                >
                  {body}
                </Pressable>
              ) : (
                <View
                  className="min-w-0 flex-1 flex-row items-center gap-3 md:gap-4"
                  accessible
                  accessibilityLabel={label}
                >
                  {body}
                </View>
              )}
              {phone ? null : <EntryActionButton entry={e} compact />}
            </View>
            {phone ? (
              <View className="flex-row justify-end">
                <EntryActionButton entry={e} compact />
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

/** Where the series data comes from (the community's series data is CC0, so this is a
 * credit, not a licence notice; CC BY-SA content carries the server's own text). */
export function SourceLine() {
  const { t } = useTranslation();
  const themed = useThemeColors();
  return (
    <View className="mt-3 flex-row items-center gap-1.5">
      <Icon name="globe" size={13} color={themed.community} />
      <Text variant="caption" className="text-subtle-foreground">
        {t('series.source')}
      </Text>
    </View>
  );
}

/** "7 entries · 4 on your servers · 3 not in your library · 120h to listen to". */
export function statsLine(stats: SeriesStats, t: TFunction): string[] {
  return [
    t('series.stats.entries', { count: stats.entries }),
    stats.missing > 0 ? t('series.stats.onServers', { count: stats.owned + stats.elsewhere }) : '',
    stats.missing > 0 ? t('series.stats.missing', { count: stats.missing }) : '',
    stats.seconds > 0 ? t('series.stats.length', { duration: formatDuration(stats.seconds) }) : '',
  ].filter(Boolean);
}
