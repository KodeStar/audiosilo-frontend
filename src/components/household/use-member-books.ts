import type { TFunction } from 'i18next';

import { ApiError, apiErrorKind } from '@/api/client';
import { CapabilityError, useCreateCollection, useDeleteCollection } from '@/api/hooks';

import { writeErrorText } from './household-model';

/** Whether a write failed with nothing changed on the server: refused (a 4xx answer), or
 * never sent (`CapabilityError`). Not when no answer came, nor a server error (5xx): the
 * write may have landed first. */
function refused(e: unknown): boolean {
  return e instanceof CapabilityError || (e instanceof ApiError && e.status < 500);
}

/** How a write that may first create "<Name>'s books" ended: its answer, or where it
 * stopped (`books`: the collection could not be created, nothing else was sent;
 * `write`: the collection was created and the write failed, and the collection deleted
 * again unless `leftBehind`: it couldn't be, or the write got no answer and may have
 * landed). */
export type BooksRun<T> =
  | { ok: true; value: T }
  | { ok: false; stage: 'books' | 'write'; error: unknown; leftBehind: boolean };

/**
 * "Create <Name>'s books" (Phase 8b-1, the access picker) is only a promise until the
 * owner saves: `run(booksName, write)` creates the collection first (when `booksName` is
 * given), then runs `write` with its id so the member's `collection_ids` can hold it, and
 * when `write` is refused deletes the collection again, so a refused add or change leaves
 * nothing behind (as Cancel never made anything). A write with no answer keeps it: it may
 * have landed, sharing it with the member. Never throws.
 */
export function useMemberBooks(connectionId: string) {
  const create = useCreateCollection(connectionId);
  const remove = useDeleteCollection(connectionId);
  const run = async <T>(
    booksName: string | null,
    write: (newId: number | null) => Promise<T>,
  ): Promise<BooksRun<T>> => {
    let made: number | null = null;
    if (booksName) {
      try {
        made = (await create.mutateAsync({ name: booksName })).id;
      } catch (error) {
        return { ok: false, stage: 'books', error, leftBehind: false };
      }
    }
    try {
      return { ok: true, value: await write(made) };
    } catch (error) {
      let leftBehind = false;
      if (made !== null) {
        // Only a refusal changed nothing on the server. No answer, or a server error, may
        // come after the write landed: the member may hold the new collection already, so
        // it stays (and the message says so).
        if (!refused(error)) leftBehind = true;
        else {
          try {
            await remove.mutateAsync(made);
          } catch {
            leftBehind = true;
          }
        }
      }
      return { ok: false, stage: 'write', error, leftBehind };
    }
  };
  return { run };
}

/** What a `BooksRun` that failed says: the collection could not be made (the server's
 * cap on collections, or anything else), or why the write was refused, and when the new
 * collection could not be deleted again, that it is still there. */
export function booksRunText(
  r: Extract<BooksRun<unknown>, { ok: false }>,
  { server, booksName }: { server: string; booksName: string | null },
  t: TFunction,
): string {
  if (r.stage === 'books') {
    return apiErrorKind(r.error) === 'conflict'
      ? t('library.collection.tooMany')
      : t('household.access.createFailed', { name: booksName ?? '' });
  }
  const why = writeErrorText(r.error, server, t);
  return r.leftBehind && booksName
    ? `${why} ${t('household.access.leftBehind', { name: booksName })}`
    : why;
}
