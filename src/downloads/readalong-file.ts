import type { ApiClient } from '@/api/client';
import type { Book } from '@/api/types';
import { type CheckedReadalongMap, hasSpans, parseReadalongMap } from '@/reader/readalong-map';

import { engine } from './engine';
import type { DownloadManifest } from './types';

// A downloaded book's read-along map (Bridge Phase 3c): `readalong.json` beside its
// `book.epub`, so the companion's Text tab follows the narration offline. The file is the
// server's map as it came (fetched like the EPUB: `client.readalongRequest`, the
// Authorization header only), checked each time it is read (`parseReadalongMap`).

/** The map's name in the book's folder (never an audio file's: those are numbered). */
export const READALONG_FILE = 'readalong.json';

type Ref = { connectionId: string; libraryId: number; path: string };

/** A map kept in a download: where, and which one (its `generated_at`). */
export type KeptReadalong = { uri: string; generatedAt: string };

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
 * Fetch the book's map into its download folder, and check what landed: its uri and
 * `generated_at`, else undefined (the server has none to serve, refused it, or sent
 * something that is no map with sentences: whatever landed goes). Optional, like the
 * EPUB: only a cancel (`signal` aborted) throws.
 */
export async function fetchReadalongFile(
  api: ApiClient,
  ref: Ref,
  signal?: AbortSignal,
): Promise<KeptReadalong | undefined> {
  const { connectionId, libraryId, path } = ref;
  const { url, headers } = api.readalongRequest(libraryId, path);
  let uri: string;
  try {
    uri = await engine.downloadFile(
      connectionId,
      libraryId,
      path,
      READALONG_FILE,
      url,
      undefined,
      signal,
      headers,
    );
  } catch (e) {
    if (signal?.aborted) throw e;
    await removeReadalongFile(ref);
    return undefined;
  }
  const map = await readReadalongFile(ref);
  if (!map || !map.generated_at || !hasSpans(map)) {
    await removeReadalongFile(ref);
    return undefined;
  }
  return { uri, generatedAt: map.generated_at };
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
