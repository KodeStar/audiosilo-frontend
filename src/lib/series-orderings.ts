import type { BookMetaSeries, BookMetaSeriesOrderingKind, BookMetaSeriesWork } from '@/api/types';

/**
 * Reading-order families on a series rail - the pure rules behind the Series tab's
 * order toggle and the "previous books" catch-up.
 *
 * A series can come in several reading orders: a PRIMARY (usually publication
 * order) plus VARIANTS whose `ordering_of` names it (a chronological order, the
 * author's recommended order). Together they are one ordering FAMILY. The server
 * collapses a family into ONE rail: the top-level `works`/`position` are the MAIN
 * view (the primary, or the variant for a book only a variant places) and the
 * family's other orders ride along as `orderings`.
 *
 * The reader's pick is remembered PER FAMILY (`familyKey`), so choosing
 * "Chronological" on one Narnia book holds on every Narnia book. Which view a rail
 * shows is `selectedView`; an unknown or stale pick falls back to the main view.
 * An older server sends none of the ordering fields, so every series is its own
 * family with exactly one view - today's behaviour, unchanged.
 */

/** One reading order of a family, normalized: the main view and every alternate
 * share this shape. `position` is the current work's place in it ('' when the work
 * is not part of this order). */
export type SeriesView = {
  id: string;
  name: string;
  ordering?: BookMetaSeriesOrderingKind;
  /** Set when this view is a variant: the family's primary id. */
  orderingOf?: string;
  position: string;
  works: BookMetaSeriesWork[];
};

/** Remembered picks: family key -> the id of the view the reader chose. */
export type OrderingPicks = Readonly<Record<string, string>>;

/** The family a rail belongs to: the primary series' id. The main view names it in
 * `ordering_of` when the main view is itself a variant; otherwise the main view IS
 * the primary (or a series with no family at all). */
export function familyKey(series: BookMetaSeries): string {
  return series.ordering_of || series.id;
}

/**
 * Every view of a rail's family, in FAMILY order: the primary first, then the
 * variants by id - metaserve's own order, reproduced here so the toggle reads the
 * same on every book of a family (for a variant-only book the main view is a
 * variant, yet "Publication" should still come first). With no ordering data this
 * is just the main view.
 */
export function seriesViews(series: BookMetaSeries): SeriesView[] {
  const main: SeriesView = {
    id: series.id,
    name: series.name,
    ordering: series.ordering,
    orderingOf: series.ordering_of || undefined,
    position: series.position ?? '',
    works: series.works,
  };
  const seen = new Set([main.id]);
  const alternates: SeriesView[] = [];
  for (const o of series.orderings ?? []) {
    // Defensive: the main view never repeats as an alternate, and a family lists a
    // series once - a duplicate would render two pills for one order.
    if (seen.has(o.id)) continue;
    seen.add(o.id);
    alternates.push({
      id: o.id,
      name: o.name,
      ordering: o.ordering,
      orderingOf: o.ordering_of || undefined,
      position: o.position ?? '',
      works: o.works ?? [],
    });
  }
  if (alternates.length === 0) return [main];
  return [main, ...alternates].sort((a, b) => {
    const variant = Number(!!a.orderingOf) - Number(!!b.orderingOf);
    if (variant !== 0) return variant;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** The view a rail shows: the remembered pick for its family when that names one of
 * the family's views, else the MAIN view (the server's default - the primary order,
 * or the only order that places a variant-only book). */
export function selectedView(series: BookMetaSeries, picks: OrderingPicks): SeriesView {
  const views = seriesViews(series);
  const pick = picks[familyKey(series)];
  return views.find((v) => v.id === pick) ?? views.find((v) => v.id === series.id) ?? views[0];
}

/** Whether the current work is part of a view: it is listed, or the view states its
 * position. A view without it lists that order anyway (with a note) and contributes
 * nothing to "previous books". */
export function viewHoldsWork(view: SeriesView, workId: string): boolean {
  return !!view.position.trim() || view.works.some((w) => w.id === workId);
}

/** The translation key for each recognised reading order. */
const ORDERING_LABEL_KEY = {
  publication: 'book.meta.ordering.publication',
  chronological: 'book.meta.ordering.chronological',
  recommended: 'book.meta.ordering.recommended',
} as const;

/** The translation key labelling a view's toggle segment, or undefined when the
 * view states no (or an unrecognised) ordering - the caller then labels it with
 * the series' own name. */
export function orderingLabelKey(
  ordering: string | undefined,
): (typeof ORDERING_LABEL_KEY)[keyof typeof ORDERING_LABEL_KEY] | undefined {
  if (!ordering || !Object.prototype.hasOwnProperty.call(ORDERING_LABEL_KEY, ordering))
    return undefined;
  return ORDERING_LABEL_KEY[ordering as keyof typeof ORDERING_LABEL_KEY];
}

/** The name a whole family goes by (the rail's heading): the primary's name when
 * the family carries it, else the main view's. Choosing an order on the toggle
 * therefore never renames the rail. */
export function familyName(series: BookMetaSeries): string {
  const primary = seriesViews(series).find((v) => !v.orderingOf);
  return primary?.name ?? series.name;
}

/** Validate a persisted picks document: keep only string -> string entries, so a
 * corrupt or foreign value can never crash a render. */
export function parsePicks(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k && typeof v === 'string' && v) out[k] = v;
  }
  return out;
}
