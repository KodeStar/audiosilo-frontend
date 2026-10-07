import type { BookMetaSeries, BookMetaSeriesWork } from '@/api/types';
import {
  familyKey,
  type OrderingPicks,
  selectedView,
  seriesViews,
  type SeriesView,
  viewHoldsWork,
} from '@/lib/series-orderings';

/** One series rail: one ordering FAMILY (see `@/lib/series-orderings`) - its main
 * series, every reading order it comes in, the order currently shown, and that
 * order's works with the current work removed. */
export type SeriesRail = {
  series: BookMetaSeries;
  /** The family key the reader's pick is remembered under. */
  family: string;
  /** Every reading order of the family, in family order (one when it has none). */
  views: SeriesView[];
  /** The order shown: the remembered pick, else the main view. */
  view: SeriesView;
  /** The shown order's works, minus the current work. */
  works: BookMetaSeriesWork[];
  /** Whether the current work is part of the shown order (else the rail says so). */
  holdsWork: boolean;
};

/** Every series rail worth rendering - one per family, showing the order `picks`
 * selects. A rail is dropped only when EVERY one of its orders is empty once the
 * current work is removed, so switching order can never make the tab vanish. The
 * screen uses the count to decide whether the Series tab exists, and passes the
 * rails straight to `BookMetaSeriesTab` - one computation, no drift. */
export function seriesRails(
  series: BookMetaSeries[] | undefined,
  currentWorkId: string,
  picks: OrderingPicks = {},
): SeriesRail[] {
  const others = (works: BookMetaSeriesWork[]) => works.filter((w) => w.id !== currentWorkId);
  return (series ?? [])
    .map((s) => {
      const views = seriesViews(s);
      const view = selectedView(s, picks, views);
      return {
        series: s,
        family: familyKey(s),
        views,
        view,
        works: others(view.works),
        holdsWork: viewHoldsWork(view, currentWorkId),
      };
    })
    .filter((r) => r.views.some((v) => others(v.works).length > 0));
}

/** A series position ("1", "2.5", "1-3.5") as a number, or undefined when it does
 * not parse. Only the FIRST number counts, so an omnibus spanning "1-3.5" sorts at
 * its start (1). Unparsable positions are never guessed at - the caller drops them,
 * because mis-ordering a series is worse than omitting an entry. */
export function seriesPositionValue(position: string | undefined): number | undefined {
  const n = parseFloat(position ?? '');
  return Number.isFinite(n) ? n : undefined;
}

/**
 * The earlier books of every series this work belongs to: the works positioned
 * BEFORE the current work, deduplicated by work id (two series can list the same
 * book) and ordered by position DESCENDING - the immediately-preceding book first,
 * since that is the one you most need catching up on.
 *
 * Reads the `rails` `seriesRails` built, so each family contributes from the ONE
 * reading order its rail shows (the reader's pick, else the main view) - the rail and
 * this list can never follow different orders, and never the union of a family's: in
 * publication order The Lion, the Witch and the Wardrobe is book 1, and offering The
 * Magician's Nephew as a "previous book" through the chronological order would spoil
 * a reader going in publication order. An order the current work is not part of
 * contributes nothing (there is no "before" in it). Different families still union.
 *
 * Entries whose position does not parse are excluded, as is a whole series whose
 * *own* current position does not parse (there is then nothing to compare against).
 * A duplicate keeps the first series' entry, so ordering is deterministic.
 */
export function previousWorks(rails: readonly SeriesRail[]): BookMetaSeriesWork[] {
  const found = new Map<string, { work: BookMetaSeriesWork; pos: number }>();
  for (const { view, works } of rails) {
    const current = seriesPositionValue(view.position);
    if (current === undefined) continue;
    // `works` is the shown order minus the current work.
    for (const w of works) {
      if (found.has(w.id)) continue;
      const pos = seriesPositionValue(w.position);
      if (pos === undefined || pos >= current) continue;
      found.set(w.id, { work: w, pos });
    }
  }
  return [...found.values()].sort((a, b) => b.pos - a.pos).map((e) => e.work);
}
