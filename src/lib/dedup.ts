/**
 * Client-side de-duplication of "the same book" across multiple server
 * connections, mirroring the server's within-server logic (see
 * audiosilo-server internal/catalog/dedup.go) so the two agree.
 *
 * A book reached through two connections (or the same book on two servers) is
 * collapsed to a single entry: the best-quality copy wins, the others become
 * "also on <server>". Quality: format tier (M4B/AAC > MP3 > other) → single-file
 * over multipart → bitrate (size÷duration) → source (connection) priority.
 */
import type { Book } from '@/api/types';

/** A book tagged with the connection it was fetched from. */
export type SourcedBook = Book & { connectionId: string; connectionName: string };

/** A merged result: the winning copy plus the other connections that also have it. */
export type MergedBook = SourcedBook & {
  also: { connectionId: string; connectionName: string }[];
};

function norm(s: string | undefined): string {
  return (s ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Grouping key for "the same book". Prefers the server-provided `dedup_key`
 * (so within- and cross-server grouping agree); otherwise asin/isbn/normalized
 * author|title|narrator. Books with no identity at all stay unique.
 */
export function bookDedupKey(b: Book): string {
  if (b.dedup_key) return b.dedup_key;
  const asin = norm(b.asin);
  if (asin) return `a:${asin}`;
  const isbn = norm(b.isbn);
  if (isbn) return `i:${isbn}`;
  const author = norm(b.author);
  const title = norm(b.title);
  if (!author && !title) return `u:${b.library_id}:${b.rel_path}`;
  return `m:${author}|${title}|${norm(b.narrator)}`;
}

const FORMAT_TIER: Record<string, number> = {
  m4b: 3,
  m4a: 3,
  mp4: 3,
  aac: 3,
  m4p: 3,
  mp3: 2,
};

function formatTier(format: string | undefined): number {
  return FORMAT_TIER[(format ?? '').toLowerCase().replace(/^\./, '')] ?? 1;
}

function bitrate(b: Book): number {
  return b.duration > 0 ? b.size / b.duration : b.size;
}

/** Whether copy `a` should win over `b`: format → single-file → bitrate → source. */
function better(a: SourcedBook, b: SourcedBook, rank: (id: string) => number): boolean {
  const ta = formatTier(a.format);
  const tb = formatTier(b.format);
  if (ta !== tb) return ta > tb;
  const singleA = !a.multi_file;
  const singleB = !b.multi_file;
  if (singleA !== singleB) return singleA;
  const ra = bitrate(a);
  const rb = bitrate(b);
  if (ra !== rb) return ra > rb;
  return rank(a.connectionId) <= rank(b.connectionId);
}

/**
 * Collapse the same book seen across connections. `rank` maps a connectionId to
 * its priority (lower = preferred); it breaks ties between equal-quality copies.
 * Result order follows first appearance (a group sits at its earliest member's
 * position), so an upstream relevance/recency order is preserved.
 */
export function dedupBooks(items: SourcedBook[], rank: (id: string) => number): MergedBook[] {
  const order: string[] = [];
  const groups = new Map<string, SourcedBook[]>();
  for (const it of items) {
    const key = bookDedupKey(it);
    const g = groups.get(key);
    if (g) {
      g.push(it);
    } else {
      groups.set(key, [it]);
      order.push(key);
    }
  }
  return order.map((key) => {
    const g = groups.get(key)!;
    let win = g[0];
    for (const m of g) {
      if (m !== win && better(m, win, rank)) win = m;
    }
    const also: MergedBook['also'] = [];
    for (const m of g) {
      if (m.connectionId === win.connectionId) continue;
      if (!also.some((x) => x.connectionId === m.connectionId)) {
        also.push({ connectionId: m.connectionId, connectionName: m.connectionName });
      }
    }
    return { ...win, also };
  });
}
