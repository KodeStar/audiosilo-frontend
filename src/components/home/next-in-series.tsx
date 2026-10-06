import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { CoverTile } from '@/components/library/cover-tile';
import { CoverTileSkeleton } from '@/components/library/cover-grid';
import { GhostCover } from '@/components/library/ghost-cover';
import { ShelfRow } from '@/components/library/shelf-row';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useOpen } from '@/lib/open';
import { useThemeColors } from '@/theme/use-theme-colors';
import { bookTitle } from '@/lib/paths';
import { formatDayMonth } from '@/lib/format';

import { useBookTitle } from './book-title';
import type { NextItem, NextReason } from './home-model';

/** Why a next book is suggested, in words; `title` names the book it follows. */
export function nextReasonText(reason: NextReason, title: string, t: TFunction): string {
  switch (reason.kind) {
    case 'current':
      return t('home.next.afterCurrent');
    case 'progress':
      return t('home.next.afterProgress', { title, percent: reason.percent });
    case 'finished': {
      const at = Date.parse(reason.at);
      return Number.isNaN(at)
        ? t('home.next.afterFinishedUndated', { title })
        : t('home.next.afterFinished', { title, date: formatDayMonth(new Date(at)) });
    }
  }
}

/**
 * Next in your series (STYLEGUIDE section 9, "Continue the series"): the book after each
 * book the listener is on or recently finished, each saying why. A next book this server
 * has is a cover tile; one the community series names but no library here holds is a
 * ghost that opens its series (shown, never played).
 */
export function NextInSeriesRow({
  items,
  labelFor,
}: {
  items: readonly NextItem[];
  /** A friend's server's name for a book on a non-default connection (the tile flag). */
  labelFor: (connectionId: string) => string | undefined;
}) {
  const { t } = useTranslation();
  return (
    <ShelfRow
      data={items}
      keyExtractor={(it) => it.key}
      accessibilityLabel={t('home.next.title')}
      renderItem={(it, width) => (
        <NextCard item={it} width={width} server={labelFor(it.connectionId)} />
      )}
    />
  );
}

function NextCard({ item, width, server }: { item: NextItem; width: number; server?: string }) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const { openSeries } = useOpen();
  const before = useBookTitle(item.reason.kind === 'current' ? null : item.reason.of);
  const reason = nextReasonText(item.reason, before, t);
  const tag = (
    <View className="flex-row gap-1.5 pt-1" style={{ width }}>
      <Icon
        name={item.kind === 'book' ? 'check' : 'circle-info'}
        size={12}
        color={themed.mutedForeground}
      />
      <Text variant="caption" className="flex-1 font-sans-semibold text-[11.5px]" numberOfLines={2}>
        {reason}
      </Text>
    </View>
  );
  if (item.kind === 'book') {
    const b = item.book;
    return (
      <View style={{ width }}>
        <CoverTile
          connectionId={item.connectionId}
          libraryId={item.libraryId}
          path={item.path}
          title={bookTitle(b.title, item.path)}
          book={b}
          author={b.author}
          caption={b.series ? seriesCaption(b.series, b.series_index) : b.author}
          coverVersion={b.cover_version}
          server={server}
          width={width}
          onShelf
        />
        {tag}
      </View>
    );
  }
  const w = item.work;
  const authors = w.authors.map((a) => a.name).join(', ');
  return (
    <View style={{ width }}>
      <AnimatedPressable
        onPress={() => openSeries(item.connectionId, item.libraryId, { work: w.id })}
        accessibilityRole="button"
        accessibilityLabel={[w.title, t('covers.notInLibrary'), reason].join(', ')}
        className="gap-2.5 rounded-cover"
      >
        <GhostCover title={w.title} position={w.position} width={width} />
        <View className="gap-0.5 pt-3">
          <Text variant="label" numberOfLines={2}>
            {w.title}
          </Text>
          {authors ? (
            <Text variant="caption" numberOfLines={1}>
              {authors}
            </Text>
          ) : null}
        </View>
      </AnimatedPressable>
      {tag}
    </View>
  );
}

/** "The Expanse · 3" (no number when it has none). */
function seriesCaption(series: string, index: number): string {
  return index ? `${series} · ${index}` : series;
}

/** A row of cover placeholders, the shape a shelf takes while it loads. */
export function ShelfSkeleton({ count = 6 }: { count?: number }) {
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <ShelfRow
        data={Array.from({ length: count }, (_, i) => i)}
        keyExtractor={(i) => String(i)}
        renderItem={(_, width) => <CoverTileSkeleton width={width} />}
      />
    </View>
  );
}
