import { useBook, useCapability, useServerInfo } from '@/api/hooks';
import type { Book } from '@/api/types';
import { useDownloadedEbook } from '@/downloads/store';
import { canRead } from '@/reader/can-read';
import type { OpenedEbook } from '@/reader/ebook-identity';
import { mayMakeReadalong } from '@/reader/readalong-gating';
import type { ReaderReadalongMap } from '@/reader/readalong-map';
import { type ReadalongFailure, useBookReadalong } from '@/reader/use-book-readalong';
import { useSession } from '@/stores/session';

import type { PlayTarget } from '../use-play-book';
import { textTab } from './companion-model';

/** The companion's Text tab for the playing book (see `useTextTab`). */
export type TextTabModel = {
  ebookSha256?: string;
  ebookSelectionKey?: string;
  onEbook?: (ebook: OpenedEbook) => void;
  selectingEbook?: boolean;
  /** The tab shows (`textTab`). */
  shown: boolean;
  /** The map to follow, or null (none: the admin's Make offer shows instead). */
  map: ReaderReadalongMap | null;
  /** The map is on its way (`useBookReadalong`): an admin's tab says so with a spinner. */
  pending: boolean;
  /** Why the map's read failed (`useBookReadalong`), else null: the tab says so (with Try
   * again, `retry`, only where it can work), and never offers Make, which would queue a job
   * the book may not need. */
  failure: ReadalongFailure | null;
  retry: () => void;
  book: Book | undefined;
};

/**
 * Whether the playing book has a Text tab, and what it holds (Bridge Phase 3c): its
 * read-along map (`useBookReadalong`: the download's copy offline, else the server's, only
 * `ready` ones), for a book that reads (`canRead`: its EPUB, from the server or the
 * download); for an admin who may make one (`mayMakeReadalong`), also the Make offer where
 * there is no map to follow (none yet, or a stale one). Call it inside the book's
 * `ConnectionScope`.
 */
export function useTextTab(target: PlayTarget): TextTabModel {
  const { connectionId, libraryId, path } = target;
  const { data: book } = useBook(libraryId, path, connectionId);
  const ebooks = useCapability('ebooks', connectionId);
  const savedEbook = useDownloadedEbook(connectionId, libraryId, path);
  const readable = canRead(ebooks, book, !!savedEbook);
  const {
    map,
    pending,
    failure,
    offline,
    retry,
    ebookSha256,
    onEbook,
    selectingEbook,
    ebookSelectionKey,
  } = useBookReadalong(target, book, readable, true, { reselectOnDownloadChange: true });
  const user = useSession((s) => s.connections.find((c) => c.id === connectionId)?.user);
  const server = useServerInfo(connectionId).data;
  const mayMake = readable && mayMakeReadalong(user, server);
  const shown = textTab({ map: map !== null, failed: failure !== null, offline, mayMake });
  return {
    shown,
    map,
    pending,
    failure,
    retry,
    book,
    ebookSha256,
    onEbook,
    selectingEbook,
    ebookSelectionKey,
  };
}
