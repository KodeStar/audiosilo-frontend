/// <reference types="node" />
import { readFileSync } from 'fs';
import { join } from 'path';

import type {
  OpmlImportResult,
  PodcastDiscoveryProviders,
  PodcastDiscoverySearch,
} from '@/api/types';

import manifest from './podcast-fixtures/phase2c3/manifest.json';
import importRows from './podcast-fixtures/phase2c3/opml/duplicates-private-expected.json';
import exportHeaders from './podcast-fixtures/phase2c3/opml/export-expected-headers.json';
import itunes from './podcast-fixtures/phase2c3/providers/itunes-normalized.json';
import podcastIndex from './podcast-fixtures/phase2c3/providers/podcast-index-normalized.json';
import wire from './podcast-fixtures/phase2c3/wire.json';

/**
 * The server's Phase 2c-3 goldens (`internal/podcast/testdata/phase2c3/`), copied byte for
 * byte into `podcast-fixtures/phase2c3/` (Bridge Phase 2d-2): the discovery and OPML wire
 * exactly as the server sends it. `manifest.json` is the server's own list of each file's
 * SHA-256, which `podcast-fixtures-2c3.test.ts` checks the copies against.
 */
export const golden2c3 = {
  wire: wire as {
    capabilities: { podcast_discovery: boolean; podcast_opml: boolean };
    providers: PodcastDiscoveryProviders;
    errors: {
      http_status: number;
      headers?: Record<string, string>;
      body: { error: string; code: string };
    }[];
  },
  itunes: itunes as PodcastDiscoverySearch,
  podcastIndex: podcastIndex as PodcastDiscoverySearch,
  importRows: importRows as OpmlImportResult,
  exportHeaders: exportHeaders as Record<string, string>,
  manifest: manifest as { files: { path: string; bytes: number; sha256: string }[] },
};

/** The directory the copies live in. */
export const GOLDEN_2C3_DIR = join(__dirname, 'podcast-fixtures', 'phase2c3');

/** A golden's bytes, by its path in the server's directory (`opml/queue-cap.opml`). */
export function goldenBytes(path: string): Uint8Array {
  return new Uint8Array(readFileSync(join(GOLDEN_2C3_DIR, path)));
}

/** A golden's text (UTF-8). */
export function goldenText(path: string): string {
  return readFileSync(join(GOLDEN_2C3_DIR, path), 'utf8');
}

/** The one wire error of `wire.json` with `code`. */
export function goldenError(code: string) {
  const e = golden2c3.wire.errors.find((x) => x.body.code === code);
  if (!e) throw new Error(`no golden error ${code}`);
  return e;
}
