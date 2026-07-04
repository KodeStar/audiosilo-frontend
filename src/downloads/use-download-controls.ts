import { useCallback } from 'react';

import { useActiveCid } from '@/api/provider';
import type { Book, ChaptersResponse } from '@/api/types';

import { useDownloadEntry, useDownloads } from './store';
import type { DownloadStatus } from './types';

export type DownloadControls = {
  supported: boolean;
  status: DownloadStatus | undefined;
  error: string | undefined;
  progress: number;
  bytes: number;
  totalBytes: number;
  start: () => void;
  cancel: () => void;
  remove: () => void;
};

/** Drives the download UI for a single book (book detail, badges). */
export function useDownloadControls(
  libraryId: number,
  path: string,
  book?: Book,
  chapterData?: ChaptersResponse,
): DownloadControls {
  // The book screen operates on the active connection, so downloads scope to it.
  const cid = useActiveCid();
  const entry = useDownloadEntry(cid, libraryId, path);
  // Reflects the SW serveability probe (downgraded after hydrate if the worker can't
  // serve offline media), not just the static Cache-API capability.
  const supported = useDownloads((s) => s.supported);

  const start = useCallback(() => {
    if (book) useDownloads.getState().download(cid, libraryId, book, chapterData);
  }, [cid, libraryId, book, chapterData]);
  const cancel = useCallback(
    () => useDownloads.getState().cancel(cid, libraryId, path),
    [cid, libraryId, path],
  );
  const remove = useCallback(
    () => void useDownloads.getState().remove(cid, libraryId, path),
    [cid, libraryId, path],
  );

  return {
    supported,
    status: entry?.status,
    error: entry?.error,
    progress: entry?.progress ?? 0,
    bytes: entry?.bytes ?? 0,
    totalBytes: entry?.totalBytes ?? 0,
    start,
    cancel,
    remove,
  };
}
