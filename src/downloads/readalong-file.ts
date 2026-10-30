import type { ApiClient } from '@/api/client';
import type { Book } from '@/api/types';
import { type CheckedReadalongMap, hasSpans, parseReadalongMap } from '@/reader/readalong-map';

import { engine } from './engine';
import type { DownloadManifest } from './types';

// A downloaded book's read-along map (Bridge Phase 3c): `readalong.json` beside its
// `book.epub`, so the companion's Text tab follows the narration offline. The file is the
// server's map as the player checked it (`client.readalong`, the Authorization header
// only), written through `engine.writeText` once it is in hand and has a sentence to
// follow, and checked again each time it is read (`parseReadalongMap`). The registry marks
// it by its `generated_at` only (`DownloadManifest.readalongGeneratedAt`).

/** The map's name in the book's folder (never an audio file's: those are numbered). */
export const READALONG_FILE = 'readalong.json';

type Ref = { connectionId: string; libraryId: number; path: string };

/** The map a download's folder holds, read and checked; null when there is none, it is
 * gone, or it is no `audiosilo-readalong/v1` map. */
export async function readReadalongFile(ref: Ref): Promise<CheckedReadalongMap | null> {
  if (!engine.readText) return null;
  const text = await engine.readText(ref.connectionId, ref.libraryId, ref.path, READALONG_FILE);
  if (!text) return null;
  try {
    return parseReadalongMap(JSON.parse(text));
  } catch {
    return null;
  }
}

/** Drop the map from a download's folder (best effort). */
export async function removeReadalongFile(ref: Ref): Promise<void> {
  await engine
    .removeFile?.(ref.connectionId, ref.libraryId, ref.path, READALONG_FILE)
    .catch(() => {});
}

/**
 * Fetch the book's map and keep it in its download folder: its `generated_at` once a map
 * with a sentence to follow is saved, else undefined (the server has none to serve, refused
 * it or could not be reached, sent no map with sentences, or the folder is gone). Nothing is
 * written until a checked map is in hand, so a map the folder already keeps stays when the
 * fetch fails. Optional, like the EPUB: only a cancel (`signal` aborted) throws.
 */
export async function fetchReadalongFile(
  api: ApiClient,
  ref: Ref,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const { connectionId, libraryId, path } = ref;
  let map: CheckedReadalongMap;
  try {
    map = await api.readalong(libraryId, path, signal);
  } catch (e) {
    if (signal?.aborted) throw e;
    return undefined;
  }
  if (!map.generated_at || !hasSpans(map) || !engine.writeText) return undefined;
  const saved = await engine.writeText(
    connectionId,
    libraryId,
    path,
    READALONG_FILE,
    JSON.stringify(map),
  );
  return saved ? map.generated_at : undefined;
}

/**
 * Whether a new download fetches the book's map: its EPUB is on the device (a map without
 * it reads nothing), the server serves maps, and the book is not known to have only a
 * stale one (a list-shape book says nothing either way: asked, a 404 is none).
 */
export function wantsReadalong(
  serves: boolean | undefined,
  book: Pick<Book, 'readalong'>,
  ebookUri: string | undefined,
): boolean {
  return (
    !!ebookUri &&
    serves === true &&
    (book.readalong === undefined || book.readalong.state === 'ready')
  );
}

/**
 * What a server's answer for a downloaded book (its `/item`) asks of the map the download
 * keeps: `fetch` a map made again (another `generated_at`, or one the download has none of
 * yet), `drop` it when the server has no ready map any more (none, or stale: an ebook or
 * audio that changed; a listener never sees a stale map), else `keep`. Nothing without the
 * book's EPUB on the device.
 */
export function readalongChange(
  book: Pick<Book, 'readalong'>,
  manifest: Pick<DownloadManifest, 'ebookUri' | 'readalongGeneratedAt'>,
): 'keep' | 'fetch' | 'drop' {
  if (!manifest.ebookUri) return 'keep';
  const ra = book.readalong;
  const wanted =
    ra?.state === 'ready' && typeof ra.generated_at === 'string' ? ra.generated_at : null;
  const have = manifest.readalongGeneratedAt ?? null;
  if (wanted === have) return 'keep';
  return wanted === null ? 'drop' : 'fetch';
}
