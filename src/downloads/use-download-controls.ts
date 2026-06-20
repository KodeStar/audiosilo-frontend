import { useCallback } from 'react';

import { useApi } from '@/api/provider';
import type { Book, ChaptersResponse } from '@/api/types';

import { engine } from './engine';
import { useDownloadEntry, useDownloads } from './store';
import type { DownloadStatus } from './types';

export type DownloadControls = {
  supported: boolean;
  status: DownloadStatus | undefined;
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
  const api = useApi();
  const entry = useDownloadEntry(libraryId, path);

  const start = useCallback(() => {
    if (book) useDownloads.getState().download(api, libraryId, book, chapterData);
  }, [api, libraryId, book, chapterData]);
  const cancel = useCallback(
    () => useDownloads.getState().cancel(libraryId, path),
    [libraryId, path],
  );
  const remove = useCallback(
    () => void useDownloads.getState().remove(libraryId, path),
    [libraryId, path],
  );

  return {
    supported: engine.supported,
    status: entry?.status,
    progress: entry?.progress ?? 0,
    bytes: entry?.bytes ?? 0,
    totalBytes: entry?.totalBytes ?? 0,
    start,
    cancel,
    remove,
  };
}
