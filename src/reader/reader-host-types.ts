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

/** The host of the reader document: the web's iframe (`reader-host.web.tsx`); the native
 * WebView host is Bridge Phase 3b-2 (`reader-host.tsx` is its placeholder). */
export type ReaderHostProps = {
  /** The book's connection's client: the host fetches the EPUB with it. */
  api: ApiClient;
  libraryId: number;
  /** The BOOK's path (the server finds its ebook). */
  path: string;
  /** The book's title, for an EPUB without one. */
  name: string;
  /** Where to open; read when the book is handed over, later changes are ignored. */
  at?: ReaderPlace;
  theme: ReaderTheme;
  fontScale: number;
  /** The frame's accessible name. */
  title: string;
  onMessage: (message: ReaderHostEvent) => void;
  /** Fetching the EPUB failed (the reader shows nothing then). */
  onLoadError: (error: unknown) => void;
  ref?: Ref<ReaderHostHandle>;
};
