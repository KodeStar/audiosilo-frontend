import { useEffect, useRef } from 'react';

import { engine } from '@/downloads/engine';
import { downloadedEntryOf } from '@/downloads/store';
import { BASE_URL } from '@/lib/base-url';
import { useLatestRef } from '@/lib/use-latest';

import { acceptReaderMessage, type HostChannel, type HostMessage } from './protocol';
import type { ReaderHostProps } from './reader-host-types';
import { startReaderSession } from './reader-session';
import { usePlaceGate } from './use-place-gate';
import { useReaderControls } from './use-reader-controls';
import { useReaderReadalong } from './use-reader-readalong';

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
 * origin (`acceptReaderMessage`) and wait until the reader says `ready`; what each one does
 * is the session both hosts share (`startReaderSession`), the read-along map, place and
 * follow too (`useReaderReadalong`).
 */
export function ReaderHost({
  api,
  connectionId,
  libraryId,
  path,
  name,
  at,
  placeKnown = true,
  theme,
  fontScale,
  title,
  onMessage,
  onLoadError,
  onReopen,
  ref,
  ...readalongProps
}: ReaderHostProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const placeGate = usePlaceGate(placeKnown);
  const channel = useRef<HostChannel | null>(null);
  const latest = useLatestRef({
    api,
    at,
    theme,
    fontScale,
    name,
    onMessage,
    onLoadError,
    onReopen,
  });

  const readalong = useReaderReadalong(channel, readalongProps, false);
  useReaderControls(channel, ref, theme, fontScale, readalong);

  // One reader session per book: the channel, the window listener and the book's bytes. The
  // client is read when the bytes are fetched: a new one (a new token) keeps the session,
  // whose frame says `ready` only once.
  useEffect(() => {
    // An open the reader has had: posted, not just held until its first `ready`.
    let delivered = false;
    let fetching: AbortController | null = null;
    const session = startReaderSession({
      post: (message: HostMessage, transfer: Transferable[]) => {
        if (message.type === 'open') delivered = true;
        frame.current?.contentWindow?.postMessage(message, window.location.origin, transfer);
      },
      callbacks: () => latest.current,
      // `ready` after an open reached it: the reader document reloaded, and the bytes it
      // had were transferred to it, so they are fetched once more, and the screen hears the
      // book is opening again. (Before the session sends what waited, which delivers a held
      // open.)
      onReady: () => {
        if (!delivered) return;
        latest.current.onReopen?.();
        openBook();
      },
      readalong,
    });
    channel.current = session.channel;
    const openBook = () => {
      fetching?.abort();
      const abort = new AbortController();
      fetching = abort;
      downloadedEbook(connectionId, libraryId, path)
        .catch(() => null)
        .then((saved) => saved ?? latest.current.api.ebook(libraryId, path, abort.signal))
        // The bytes are in: the book goes over once the screen knows where it opens.
        .then(async (book) => {
          await placeGate();
          return book;
        })
        .then((book) => {
          if (abort.signal.aborted) return;
          const { at: place, theme: look, fontScale: scale, name: bookName } = latest.current;
          session.channel.send(
            { type: 'open', book, name: bookName, at: place, theme: look, fontScale: scale },
            [book],
          );
        })
        .catch((e: unknown) => {
          if (!abort.signal.aborted) latest.current.onLoadError(e);
        });
    };
    const onWindowMessage = (event: MessageEvent) => {
      const message = acceptReaderMessage(
        event,
        frame.current?.contentWindow,
        window.location.origin,
      );
      if (message) session.receive(message);
    };
    window.addEventListener('message', onWindowMessage);
    openBook();
    return () => {
      session.end();
      window.removeEventListener('message', onWindowMessage);
      fetching?.abort();
      channel.current = null;
    };
  }, [connectionId, libraryId, path, latest, readalong, placeGate]);

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
