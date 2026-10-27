import type { Ref } from 'react';

import type { ApiClient } from '@/api/client';

import type { GotoTarget, ReaderMessage, ReaderPlace, ReaderTheme } from './protocol';

/** What the reader screen can ask of the host. */
export type ReaderHostHandle = {
  goto(target: GotoTarget): void;
  next(): void;
  prev(): void;
};

/** The reader's messages the screen handles (the host keeps `ready` and `csp`). */
export type ReaderHostEvent = Exclude<ReaderMessage, { type: 'ready' } | { type: 'csp' }>;

/** The host of the reader document: the web's iframe (`reader-host.web.tsx`), the app's
 * WebView (`reader-host.native.tsx`, Bridge Phase 3b-2). */
export type ReaderHostProps = {
  /** The book's connection's client: the host fetches the EPUB with it. */
  api: ApiClient;
  /** The book's connection: where its download (and the app's cached EPUB) is kept. */
  connectionId: string;
  libraryId: number;
  /** The BOOK's path (the server finds its ebook). */
  path: string;
  /** The server's size of the book's ebook (`Book.ebook.size`): the app fetches its
   * cached copy again when it differs. Read when the host mounts (one file per mount): a
   * size that changes while the reader is open is fetched on the next open. */
  ebookSize: number;
  /** The book's title, for an EPUB without one. */
  name: string;
  /** Where to open; read when the book is handed over, later changes are ignored. */
  at?: ReaderPlace;
  theme: ReaderTheme;
  fontScale: number;
  /** The frame's accessible name. */
  title: string;
  onMessage: (message: ReaderHostEvent) => void;
  /** Fetching the EPUB failed, or the reader document did not start or keep running (a
   * `ReaderStartError`); the reader shows nothing then. */
  onLoadError: (error: unknown) => void;
  /** The reader document was made again (the app's WebView after its content process
   * died, the web's frame after it reloaded): the book shows again with its next
   * `opened`. */
  onReopen?: () => void;
  ref?: Ref<ReaderHostHandle>;
};

/** How long the reader document may take to say `ready`. One that never does says nothing
 * at all (on the web a proxy refusing the frame or its script, or a browser that cannot run
 * it; in the app a WebView that never starts), so past this it is a failed load
 * (`ReaderStartError`), instead of a spinner for good. */
export const READER_START_MS = 30_000;

/** The reader document did not start or keep running. On the web it never said `ready`
 * within READER_START_MS: a proxy's policy refused the frame or its script, or the browser
 * cannot run it. In the app the WebView never said `ready` within READER_START_MS, or its
 * content process died more than MAX_RELOADS times without staying open (`STABLE_MS`,
 * `reader-host.native.tsx`). The screen says a reopen that failed the same way. Not the
 * server's silence: the book may have arrived. */
export class ReaderStartError extends Error {
  constructor() {
    super('the reader document did not start');
    this.name = 'ReaderStartError';
  }
}
