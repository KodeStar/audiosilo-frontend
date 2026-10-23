/// <reference types="node" />
import { createHash } from 'crypto';
import { existsSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

import { GOLDEN_2C3_DIR, golden2c3, goldenBytes } from './podcast-fixtures-2c3';

/** Every file under `dir`, as paths relative to it. */
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? files(full) : [relative(GOLDEN_2C3_DIR, full)];
  });
}

describe('the Phase 2c-3 goldens', () => {
  // The copies must stay byte-identical to the server's (its manifest names each file's
  // SHA-256): a drift here is a wire change one side has not taken.
  const copied = files(GOLDEN_2C3_DIR).filter((p) => p !== 'manifest.json');

  it('copies the files the player tests read', () => {
    expect(copied.sort()).toEqual([
      'opml/duplicates-private-expected.json',
      'opml/export-expected-headers.json',
      'opml/export-expected.opml',
      'opml/queue-cap.opml',
      'providers/itunes-normalized.json',
      'providers/podcast-index-normalized.json',
      'wire.json',
    ]);
    expect(existsSync(join(GOLDEN_2C3_DIR, 'manifest.json'))).toBe(true);
  });

  it.each(copied)('%s matches the server manifest', (path) => {
    const entry = golden2c3.manifest.files.find((f) => f.path === path);
    expect(entry).toBeDefined();
    const bytes = goldenBytes(path);
    expect(bytes.length).toBe(entry!.bytes);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry!.sha256);
  });
});
