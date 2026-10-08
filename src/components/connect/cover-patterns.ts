import { CLOTH_COLORS, hashString } from '@/lib/monogram';

/**
 * The generated covers of the connect screens' cascade: before sign-in there are no
 * real covers, and a made-up title could pass for one of the listener's books, so each
 * tile is an abstract cloth square with one motif, or a dashed ghost. Deterministic (the
 * same tiles on every render and in every test).
 */

export type PatternMotif = 'sun' | 'arcs' | 'bands' | 'dots' | 'peak' | 'ghost';

export type PatternTile = { motif: PatternMotif; cloth: string; accent: string };

const MOTIFS: readonly Exclude<PatternMotif, 'ghost'>[] = ['sun', 'arcs', 'bands', 'dots', 'peak'];

/** Warm and pale accents that read on every cloth colour (content colours, like art). */
const ACCENTS = ['#f2c14e', '#e76f51', '#8ecae6', '#f4a261', '#e9d8a6', '#94d2bd'] as const;

/** One in this many tiles is a ghost. */
const GHOST_EVERY = 7;

/** The tile at a cascade position. */
export function patternTile(column: number, row: number): PatternTile {
  const h = hashString(`cascade:${column}:${row}`);
  const motif: PatternMotif = h % GHOST_EVERY === 0 ? 'ghost' : MOTIFS[(h >>> 3) % MOTIFS.length];
  return {
    motif,
    cloth: CLOTH_COLORS[(h >>> 7) % CLOTH_COLORS.length],
    accent: ACCENTS[(h >>> 11) % ACCENTS.length],
  };
}

/** `columns` columns of `rows` tiles each. */
export function cascadeColumns(columns: number, rows: number): PatternTile[][] {
  return Array.from({ length: columns }, (_, c) =>
    Array.from({ length: rows }, (_, r) => patternTile(c, r)),
  );
}

/** `count` tiles with a motif (no ghosts): the phone's fan, where a ghost would read as a
 * gap. */
export function solidTiles(count: number): PatternTile[] {
  const out: PatternTile[] = [];
  for (let row = 0; out.length < count; row++) {
    const tile = patternTile(0, row);
    if (tile.motif !== 'ghost') out.push(tile);
  }
  return out;
}
