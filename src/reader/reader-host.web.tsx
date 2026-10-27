import { useEffect, useRef } from 'react';

import { engine } from '@/downloads/engine';
import { downloadedEntryOf } from '@/downloads/store';
import { BASE_URL } from '@/lib/base-url';
import { useLatestRef } from '@/lib/use-latest';

import {
  acceptReaderMessage,
  createHostChannel,
  type HostChannel,
  type HostMessage,
} from './protocol';
import { READER_START_MS, type ReaderHostProps, ReaderStartError } from './reader-host-types';
import { useReaderControls } from './use-reader-controls';

/** The reader document the web export serves beside the app (`public/reader.html`). */
export const READER_URL = `${BASE_URL}/reader.html`;

/** The book's EPUB as this browser has it in its download (Bridge Phase 3b-2), else null:
 * read whenever it is there, so a downloaded book reads offline. */
async function downloadedEbook(
  connectionId: string,
  libraryId: number,
  path: string,
): Promise<ArrayBuffer | null> {
  const uri = downloadedEntryOf({ connectionId, libraryId, path })?.manifest.ebookUri;
  if (!uri || !engine.readFile) return null;
  const bytes = await engine.readFile(uri);
  return bytes && bytes.byteLength > 0 ? bytes : null;
}

/**
 * The web reader host: the reader document in an iframe, same-origin (foliate cannot run
 * in an opaque origin) but sandboxed (no popups, top navigation, forms or modals). The host
 * reads the EPUB from the book's download, else fetches it with the session's
 * `Authorization` header, and hands the reader only the bytes, as a transferable: the reader never sees a token or an API URL, and foliate never
 * runs in the `/web` document. Messages are taken only from this frame's window on our own
 * origin (`acceptReaderMessage`) and wait until the reader says `ready`.
 */
export function ReaderHost({
  api,
  connectionId,
  libraryId,
  path,
  name,
  at,
  theme,
  fontScale,
  title,
  onMessage,
  onLoadError,
  ref,
}: ReaderHostProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const channel = useRef<HostChannel | null>(null);
  const latest = useLatestRef({ api, at, theme, fontScale, name, onMessage, onLoadError });

  useReaderControls(channel, ref, theme, fontScale);

  // One reader session per book: the channel, the window listener and the book's bytes. The
  // client is read when the bytes are fetched: a new one (a new token) keeps the session,
  // whose frame says `ready` only once.
  useEffect(() => {
    // An open the reader has had: posted, not just held until its first `ready`.
    let delivered = false;
    const session = createHostChannel((message: HostMessage, transfer: Transferable[]) => {
      if (message.type === 'open') delivered = true;
      frame.current?.contentWindow?.postMessage(message, window.location.origin, transfer);
    });
    channel.current = session;
    let fetching: AbortController | null = null;
    const openBook = () => {
      fetching?.abort();
      const abort = new AbortController();
      fetching = abort;
      downloadedEbook(connectionId, libraryId, path)
        .catch(() => null)
        .then((saved) => saved ?? latest.current.api.ebook(libraryId, path, abort.signal))
        .then((book) => {
          if (abort.signal.aborted) return;
          const { at: place, theme: look, fontScale: scale, name: bookName } = latest.current;
          session.send(
            { type: 'open', book, name: bookName, at: place, theme: look, fontScale: scale },
            [book],
          );
        })
        .catch((e: unknown) => {
          if (!abort.signal.aborted) latest.current.onLoadError(e);
        });
    };
    const starting = setTimeout(
      () => latest.current.onLoadError(new ReaderStartError()),
      READER_START_MS,
    );
    const onWindowMessage = (event: MessageEvent) => {
      const message = acceptReaderMessage(
        event,
        frame.current?.contentWindow,
        window.location.origin,
      );
      if (!message) return;
      switch (message.type) {
        case 'ready':
          clearTimeout(starting);
          // `ready` after an open reached it: the reader document reloaded, and the bytes
          // it had were transferred to it, so they are fetched once more. (Checked before
          // `session.ready()`, which delivers a held open.)
          if (delivered) openBook();
          session.ready();
          return;
        case 'csp':
          // A load the reader's policy blocked (an EPUB's beacon, script or font).
          console.warn('[reader] blocked by CSP:', message.directive, message.blocked);
          return;
        default:
          latest.current.onMessage(message);
      }
    };
    window.addEventListener('message', onWindowMessage);
    openBook();
    return () => {
      clearTimeout(starting);
      window.removeEventListener('message', onWindowMessage);
      fetching?.abort();
      channel.current = null;
    };
  }, [connectionId, libraryId, path, latest]);

  return (
    <iframe
      ref={frame}
      src={READER_URL}
      title={title}
      sandbox="allow-scripts allow-same-origin"
      referrerPolicy="no-referrer"
      style={{ border: 0, width: '100%', height: '100%', display: 'block' }}
    />
  );
}
