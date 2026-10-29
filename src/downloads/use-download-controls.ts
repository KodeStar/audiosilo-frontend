import { useCallback } from 'react';

import { useScopedCid } from '@/api/provider';
import type { Book, ChaptersResponse } from '@/api/types';
import { useNeedsWebTranscode } from '@/playback/transcode-capability';

import { useDownloads, useDownloadState } from './store';
import type { DownloadStatus } from './types';

export type DownloadControls = {
  /** The connection the download belongs to. */
  connectionId: string;
  supported: boolean;
  /** Web only: this book streams through the server's transcoder here, so its raw
   * files would not play offline in this browser and downloading it is off (`supported`
   * is false too). Lets the UI say why instead of a generic "unavailable". */
  needsTranscode: boolean;
  status: DownloadStatus | undefined;
  error: string | undefined;
  start: () => void;
  cancel: () => void;
};

/** Drives the download UI for a single book (book detail, badges, a book's actions): its
 * state and the start/cancel actions, never the progress numbers, so a download's ticks
 * re-render none of its callers. What draws the progress reads `useDownloadProgress`
 * (`@/downloads/store`) beside it. */
export function useDownloadControls(
  libraryId: number,
  path: string,
  book?: Book,
  chapterData?: ChaptersResponse,
  connectionId?: string,
): DownloadControls {
  // The book screen's connection scope (from its `?connection=` query param) keys
  // downloads, unless the caller names the connection (a list of several servers).
  const scoped = useScopedCid();
  const cid = connectionId ?? scoped;
  const { status, error } = useDownloadState(cid, libraryId, path);
  // Reflects the SW serveability probe (downgraded after hydrate if the worker can't
  // serve offline media), not just the static Cache-API capability.
  const storeSupported = useDownloads((s) => s.supported);
  // A download already on disk stays manageable (remove), so only an absent or failed
  // one is blocked.
  const transcoded = useNeedsWebTranscode(book, chapterData, cid);
  const needsTranscode = transcoded && (status === undefined || status === 'error');
  const supported = storeSupported && !needsTranscode;

  const start = useCallback(() => {
    if (book) useDownloads.getState().download(cid, libraryId, book, chapterData);
  }, [cid, libraryId, book, chapterData]);
  const cancel = useCallback(
    () => useDownloads.getState().cancel(cid, libraryId, path),
    [cid, libraryId, path],
  );

  return {
    connectionId: cid,
    supported,
    needsTranscode,
    status,
    error,
    start,
    cancel,
  };
}
