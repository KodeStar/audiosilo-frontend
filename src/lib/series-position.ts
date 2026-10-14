/**
 * Series positions, single ("3", "2.5") or a range (an omnibus of books 1-3). A book
 * carries its range as `series_index` (the start) plus `series_index_end`, a series
 * membership as `position` plus `position_end`, and a community rail entry as text
 * ("1-3"). Every screen reads and writes them through these helpers, so a range is
 * parsed, shown and placed one way. Pure.
 */

/** A series position: its start, and its end when it is a range (always past `start`). */
export type SeriesSpan = { start: number; end?: number };

/** "1-3", "1 - 3" or "1–3" (en dash), with whole or decimal numbers. */
const RANGE = /^\s*(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)\s*$/;

/** The largest position and the widest range (end - start) the server takes
 * (`metadata.ValidSeriesRange`): a range outside them is no range there either. */
const MAX_POSITION = 100_000;
const MAX_SPAN = 100;

/** A span from a start and an optional end; the end is kept only for a range the server
 * would take one as: past a start above 0, at most `MAX_POSITION`, at most `MAX_SPAN`
 * places on. */
export function seriesSpan(start: number, end?: number): SeriesSpan {
  return end !== undefined &&
    start > 0 &&
    end > start &&
    end <= MAX_POSITION &&
    end - start <= MAX_SPAN
    ? { start, end }
    : { start };
}

/**
 * A rail position's text as a span, or undefined when it does not parse. The start is
 * its FIRST number ("2.5" -> 2.5, "1-3" -> 1), so an omnibus sorts at its start; the end
 * is set only for a well-formed range the server takes as one (`seriesSpan`: "3-1" and
 * "0-3" are just their start).
 * Unparsable positions are never guessed at: callers drop or append them.
 */
export function parseSeriesPosition(text: string | undefined): SeriesSpan | undefined {
  const start = seriesPositionValue(text);
  if (start === undefined) return undefined;
  const range = RANGE.exec(text ?? '');
  return range ? seriesSpan(start, Number(range[2])) : { start };
}

/** A rail position's text as the number it sorts by (its first number, so a range's
 * start), or undefined. */
export function seriesPositionValue(text: string | undefined): number | undefined {
  const n = parseFloat(text ?? '');
  return Number.isFinite(n) ? n : undefined;
}

/** A span's last slot: its end, else its start. */
export function spanEnd(span: SeriesSpan): number {
  return span.end ?? span.start;
}

/** Whether `span` holds slot `n` (start..end inclusive; a single position holds itself). */
export function spanCovers(span: SeriesSpan, n: number): boolean {
  return n >= span.start && n <= spanEnd(span);
}

/** A position as shown, without a "#" or "Book": "3", "2.5", "1-3"; '' when it has none
 * (a start of 0 or less). */
export function seriesNumber(start: number | undefined, end?: number): string {
  if (!start || start < 0) return '';
  const span = seriesSpan(start, end);
  return span.end === undefined ? String(start) : `${start}-${span.end}`;
}

/** A book's position in its `series` as shown ("3", "1-3"), '' when it has none. */
export function bookSeriesNumber(book: { series_index?: number; series_index_end?: number }) {
  return seriesNumber(book.series_index, book.series_index_end);
}

/** A book's position in its `series` as a span (start 0 when it has none). */
export function bookSeriesSpan(book: {
  series_index: number;
  series_index_end?: number;
}): SeriesSpan {
  return seriesSpan(book.series_index, book.series_index_end);
}

/** A rail position's text as shown: a range in its one form ("1 - 3" -> "1-3"), anything
 * else as the rail wrote it (trimmed). */
export function railPositionLabel(text: string | undefined): string {
  const span = parseSeriesPosition(text);
  return span?.end !== undefined ? seriesNumber(span.start, span.end) : (text ?? '').trim();
}

/** A rail entry's position as shown for the book placed on it (`local`): the book's
 * range when the server placed an omnibus at the single entry it starts at (an owned
 * 1-3 on entry "1" is "1-3", and holds what it covers), else the rail's own label. */
export function placedPositionLabel(
  text: string | undefined,
  book: { series_index?: number; series_index_end?: number } | undefined,
): string {
  const at = parseSeriesPosition(text);
  const own = book?.series_index ? seriesSpan(book.series_index, book.series_index_end) : undefined;
  return at && at.end === undefined && own?.end !== undefined && own.start === at.start
    ? seriesNumber(own.start, own.end)
    : railPositionLabel(text);
}
