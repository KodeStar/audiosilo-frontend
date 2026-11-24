import type { Book } from '@/api/types';

/** A book of The Expanse for the series tests (fe#313): a folder at
 * `Corey/Expanse/<title>`, numbered `index` in the series, its id the index. `extra`
 * overrides any field. */
export function seriesBook(title: string, index: number, extra: Partial<Book> = {}): Book {
  return {
    id: index,
    library_id: 1,
    rel_path: `Corey/Expanse/${title}`,
    is_folder: true,
    title,
    author: 'James S. A. Corey',
    series: 'The Expanse',
    series_index: index,
    narrator: 'Jefferson Mays',
    duration: 36_000,
    format: 'm4b',
    size: 1,
    ...extra,
  };
}
