import { useTranslation } from 'react-i18next';
import { Platform, Pressable, ScrollView, View } from 'react-native';

import { FilterChip } from '@/components/ui/filter-chip';
import { HORIZONTAL_SCROLLER } from '@/components/ui/horizontal-scroller';
import { FOCUS_RING_OFFSET_CLASS, Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

import { StoryBackground } from './story-background';
import { StoryText } from './story-text';
import type { CardCopy } from './year-copy';
import type { YearCard } from './year-model';

/** A thumbnail is at least this wide (the prototype's `minmax(92px, 1fr)`). */
const THUMB_MIN = 92;
const THUMB_GAP = 10;

/** How many thumbnails fit a row `width` wide, and how wide each is. */
export function thumbLayout(width: number): { columns: number; size: number } {
  if (width <= 0) return { columns: 3, size: THUMB_MIN };
  const columns = Math.max(2, Math.floor((width + THUMB_GAP) / (THUMB_MIN + THUMB_GAP)));
  return { columns, size: Math.floor((width - (columns - 1) * THUMB_GAP) / columns) };
}

/**
 * The cards as thumbnails (the prototype's `.year-grid`): each on its card's ground, its
 * number and what it shows; the one on stage is marked with the brand border (the
 * view's one pink thing). Pressing one goes to that card.
 */
export function YearThumbs({
  cards,
  copies,
  current,
  width,
  onSelect,
}: {
  cards: readonly YearCard[];
  copies: readonly CardCopy[];
  /** The card on stage, if any (the phone intro has none). */
  current?: number;
  width: number;
  onSelect: (index: number) => void;
}) {
  const { t } = useTranslation();
  const { size } = thumbLayout(width);
  return (
    <View className="flex-row flex-wrap" style={{ gap: THUMB_GAP }}>
      {cards.map((card, i) => {
        const on = i === current;
        return (
          <Pressable
            key={`${card.kind}-${i}`}
            role="button"
            accessibilityLabel={t('year.thumbLabel', { n: i + 1, label: copies[i]?.thumb ?? '' })}
            accessibilityState={{ selected: on }}
            aria-current={on ? 'true' : undefined}
            onPress={() => onSelect(i)}
            className={cn(
              'justify-end overflow-hidden rounded-card border-2 p-3.5',
              on ? 'border-brand' : 'border-transparent',
              Platform.select({ web: `cursor-pointer ${FOCUS_RING_OFFSET_CLASS}` }),
            )}
            style={{ width: size, height: Math.round(size * 1.25) }}
          >
            <StoryBackground theme={card.theme} />
            <StoryText
              className="font-sans-bold uppercase"
              style={{ fontSize: 10.5, lineHeight: 14, letterSpacing: 0.8, opacity: 0.8 }}
              numberOfLines={1}
            >
              {t('year.thumbKicker', { n: i + 1 })}
            </StoryText>
            <StoryText
              className="font-display"
              style={{ fontSize: 15, lineHeight: 17, letterSpacing: -0.3 }}
              numberOfLines={3}
            >
              {copies[i]?.thumb}
            </StoryText>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * The pickers above a story: the server (only with more than one that keeps stats) and
 * the year (only when an earlier year has a story too). Chips, in a row that scrolls
 * sideways when it doesn't fit.
 */
export function YearPickers({
  servers,
  cid,
  onServer,
  years,
  year,
  onYear,
}: {
  servers: readonly { id: string; name: string }[];
  cid: string;
  onServer: (cid: string) => void;
  /** Every year with a story, newest first (this year first). */
  years: readonly number[];
  /** The year on show. */
  year: number | null;
  onYear: (year: number) => void;
}) {
  const { t } = useTranslation();
  const showServers = servers.length > 1;
  const showYears = years.length > 1;
  if (!showServers && !showYears) return null;
  return (
    <View className="gap-2">
      {showServers ? (
        <ChipRow label={t('year.servers')}>
          {servers.map((s) => (
            <FilterChip
              key={s.id}
              label={s.name}
              icon="server"
              selected={s.id === cid}
              onPress={() => onServer(s.id)}
            />
          ))}
        </ChipRow>
      ) : null}
      {showYears ? (
        <ChipRow label={t('year.years')}>
          {years.map((y) => (
            <FilterChip key={y} label={String(y)} selected={y === year} onPress={() => onYear(y)} />
          ))}
        </ChipRow>
      ) : null}
    </View>
  );
}

function ChipRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View role="group" accessibilityLabel={label} className="flex-row items-center gap-3">
      <Text variant="eyebrow" className="w-14 shrink-0">
        {label}
      </Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={HORIZONTAL_SCROLLER}
        contentContainerClassName="gap-2 py-1.5"
      >
        {children}
      </ScrollView>
    </View>
  );
}
