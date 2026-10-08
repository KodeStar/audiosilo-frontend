import { CLOTH_COLORS } from '@/lib/monogram';

import { cascadeColumns, patternTile, solidTiles } from './cover-patterns';

it('is deterministic: the same tile at the same place', () => {
  expect(patternTile(2, 3)).toEqual(patternTile(2, 3));
  expect(cascadeColumns(6, 7)).toEqual(cascadeColumns(6, 7));
});

it('fills the grid with cloth tiles and a few ghosts, never all alike', () => {
  const tiles = cascadeColumns(6, 7).flat();
  expect(tiles).toHaveLength(42);
  const ghosts = tiles.filter((t) => t.motif === 'ghost').length;
  expect(ghosts).toBeGreaterThan(0);
  expect(ghosts).toBeLessThan(tiles.length / 3);
  expect(new Set(tiles.map((t) => t.motif)).size).toBeGreaterThan(3);
  for (const t of tiles) expect(CLOTH_COLORS).toContain(t.cloth);
});

it('solidTiles: the fan never has a ghost (a gap)', () => {
  const tiles = solidTiles(5);
  expect(tiles).toHaveLength(5);
  expect(tiles.every((t) => t.motif !== 'ghost')).toBe(true);
});
