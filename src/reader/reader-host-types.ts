import type { Ref } from 'react';

import type { ApiClient } from '@/api/client';

import type {
  GotoTarget,
  ReadalongPosition,
  ReadalongState,
  ReaderMessage,
  ReaderPlace,
  ReaderTheme,
} from './protocol';
import type { ReaderReadalongMap } from './readalong-map';

/** What the reader screen can ask of the host. */
export type ReaderHostHandle = {
  goto(target: GotoTarget): void;
  next(): void;
  prev(): void;
  /** Read-along: back to the narration (turn to the sentence being read, and follow it). */
  follow(): void;
  /** Read-along: send the narration's place now (`readalongPosition`), not at the next
   * second: after a play, a pause, a seek or a speed change. */
  syncPosition(): void;
};

/** The reader's messages the screen handles through `onMessage` (the host keeps `ready`
 * and `csp`; the read-along ones go to their own callbacks). */
export type ReaderHostEvent = Exclude<
  ReaderMessage,
  | { type: 'ready' }
  | { type: 'csp' }
  | { type: 'seek' }
  | { type: 'following' }
  | { type: 'readalong' }
>;

/** The host's read-along props (Bridge Phase 3c): what drives the reader's follow mode. */
export type ReaderReadalongProps = {
  /** The book's read-along map (`readerMapOf` of `useReadalong`'s), or null/absent for
   * none. Sent to every new reader document, and again when it changes (by identity), so
   * keep it memoised. */
  readalongMap?: ReaderReadalongMap | null;
  /** The narration's place now (whole-book seconds, speed, playing), or null while there is
   * none (another book playing): read once a second while a map is in, and on
   * `syncPosition()`. */
  readalongPosition?: () => ReadalongPosition | null;
  /** Follow the narration as soon as a map is in (the companion's Text tab), instead of
   * waiting for `follow()` (the full-screen reader's Follow narration). A reader document
   * made again (a reload) follows as the last one last said (`following`). */
  followNarration?: boolean;
  /** A sentence was tapped: play from `t` (whole-book seconds). */
  onSeek?: (t: number) => void;
  /** The reader follows the narration (true), or stopped following it (false: the reader
   * turned the page away from the sentence being read). */
  onFollowing?: (value: boolean) => void;
  /** What the reader made of the map (`ok`: a sentence of it is in this book). */
  onReadalongState?: (state: ReadalongState) => void;
};

/** The host of the reader document: the web's iframe (`reader-host.web.tsx`), the app's
 * WebView (`reader-host.native.tsx`, Bridge Phase 3b-2). */
export type ReaderHostProps = ReaderReadalongProps & {
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
