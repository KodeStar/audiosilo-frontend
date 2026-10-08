import { resolveClient } from '@/api/connection-clients';
import { chaptersQuery, fetchFailFast, itemQuery } from '@/api/hooks';
import type { Book, ChaptersResponse, Progress } from '@/api/types';
import { downloadedEntryOf } from '@/downloads/store';
import type { DownloadManifest } from '@/downloads/types';

import type { BookRef } from './types';

/**
 * Where a book plays from, and where it resumes: the rules `playBook`, `adoptLoaded`,
 * `startBookInPlace` and the car share, in one place so they cannot drift apart.
 */

/** The local files a downloaded book plays from (`buildBookQueue`'s `local`). */
export type LocalFiles = { files: Map<string, string>; artwork?: string };

/** The `local` files map + artwork a downloaded book plays from, from its manifest: the
 * one shape every `buildBookQueue` call over a download takes (`playBook`, the hot swap to
 * a finished download, `adoptLoaded`, the car's play specs). */
export function localFromManifest(manifest: DownloadManifest): LocalFiles {
  return {
    files: new Map(manifest.files.map((f) => [f.relPath, f.localUri] as const)),
    artwork: manifest.coverUri ?? undefined,
  };
}

/**
 * Where a book resumes from its saved place (the resume lookup's newest record). An
 * unfinished book resumes where it left off. A FINISHED book instead starts again at 0 (a
 * deliberate re-listen): `finishBook` saves the finished position at the whole-book end
 * (within `FINISHED_TOLERANCE` of its duration), so resuming there would strand the
 * listener at the very end and at once fire the end-of-book flow again. A book "marked as
 * finished" mid-book carries the flag too: either way the flag is the listener's "done",
 * so its saved position is ignored. The speed is `bookSpeed(progress.playback_speed, ...)`.
 */
export function resumeStart(progress: Pick<Progress, 'finished' | 'position'>): number {
  return !progress.finished && progress.position > 0 ? progress.position : 0;
}

/** A book's item and chapters, and its local files when it is downloaded. */
export type BookSource = { book: Book; chapters?: ChaptersResponse; local?: LocalFiles };

/**
 * A book's item and chapters, framework-free: the downloaded copy's (no network, no
 * connection needed: a downloaded book starts offline, and while its connection's token
 * failed to hydrate), else through the query cache (`fetchFailFast`: it always settles;
 * a book whose page is open is not asked again). Null when it is not downloaded and its
 * connection is gone; rejects when the server can't be read.
 */
export async function bookSourceOf(ref: BookRef): Promise<BookSource | null> {
  const dl = downloadedEntryOf(ref);
  if (dl) {
    return {
      book: dl.manifest.book,
      chapters: dl.manifest.chapters ?? undefined,
      local: localFromManifest(dl.manifest),
    };
  }
  const { connectionId, libraryId, path } = ref;
  const client = resolveClient(connectionId);
  if (!client) return null;
  const [book, chapters] = await Promise.all([
    fetchFailFast({ ...itemQuery(connectionId, client, libraryId, path), staleTime: 30_000 }),
    fetchFailFast({ ...chaptersQuery(connectionId, client, libraryId, path), staleTime: 30_000 }),
  ]);
  return { book, chapters };
}
