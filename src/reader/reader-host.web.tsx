import { useEffect, useImperativeHandle, useRef } from 'react';

import { BASE_URL } from '@/lib/base-url';
import { useLatestRef } from '@/lib/use-latest';

import {
  acceptReaderMessage,
  createHostChannel,
  type GotoTarget,
  type HostChannel,
  type HostMessage,
} from './protocol';
import type { ReaderHostProps } from './reader-host-types';

/** The reader document the web export serves beside the app (`public/reader.html`). */
export const READER_URL = `${BASE_URL}/reader.html`;

/**
 * The web reader host: the reader document in an iframe, same-origin (foliate cannot run
 * in an opaque origin) but sandboxed (no popups, top navigation, forms or modals). The host
 * fetches the EPUB with the session's `Authorization` header and hands the reader only the
 * bytes, as a transferable: the reader never sees a token or an API URL, and foliate never
 * runs in the `/web` document. Messages are taken only from this frame's window on our own
 * origin (`acceptReaderMessage`) and wait until the reader says `ready`.
 */
export function ReaderHost({
  api,
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
  const latest = useLatestRef({ at, theme, fontScale, name, onMessage, onLoadError });

  useImperativeHandle(
    ref,
    () => ({
      goto: (target: GotoTarget) => channel.current?.send({ type: 'goto', ...target }),
      next: () => channel.current?.send({ type: 'next' }),
      prev: () => channel.current?.send({ type: 'prev' }),
    }),
    [],
  );

  // One reader session per book: the channel, the window listener and the book's bytes.
  useEffect(() => {
    const session = createHostChannel((message: HostMessage, transfer: Transferable[]) => {
      frame.current?.contentWindow?.postMessage(message, window.location.origin, transfer);
    });
    channel.current = session;
    let fetching: AbortController | null = null;
    let sent = false;
    const openBook = () => {
      fetching?.abort();
      const abort = new AbortController();
      fetching = abort;
      api
        .ebook(libraryId, path, abort.signal)
        .then((book) => {
          if (abort.signal.aborted) return;
          const { at: place, theme: look, fontScale: scale, name: bookName } = latest.current;
          sent = true;
          session.send(
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
      if (!message) return;
      switch (message.type) {
        case 'ready':
          // `ready` again: the reader document reloaded, and the bytes it had were
          // transferred to it, so they are fetched once more.
          if (sent) openBook();
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
      window.removeEventListener('message', onWindowMessage);
      fetching?.abort();
      channel.current = null;
    };
  }, [api, libraryId, path, latest]);

  // A theme or text size change after the book opened (by value: `open` carried the first).
  const { scheme, background, foreground } = theme;
  const appearanceSent = useRef(`${scheme}${background}${foreground}${fontScale}`);
  useEffect(() => {
    const key = `${scheme}${background}${foreground}${fontScale}`;
    if (appearanceSent.current === key) return;
    appearanceSent.current = key;
    channel.current?.send({
      type: 'appearance',
      theme: { scheme, background, foreground },
      fontScale,
    });
  }, [scheme, background, foreground, fontScale]);

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
