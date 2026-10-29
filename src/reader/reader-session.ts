import {
  createHostChannel,
  type HostChannel,
  type HostMessage,
  type ReaderMessage,
} from './protocol';
import {
  READER_START_MS,
  type ReaderHostEvent,
  type ReaderHostProps,
  ReaderStartError,
} from './reader-host-types';

/** The reader's read-along messages (`seek`, `following`, `readalong`). */
export type ReadalongMessage = Extract<
  ReaderMessage,
  { type: 'seek' } | { type: 'following' } | { type: 'readalong' }
>;

/** A session's read-along side (`useReaderReadalong`): told of each new document, and
 * handed the reader's read-along messages. */
export type ReadalongLink = {
  /** The document said `ready` (its held messages sent): send it the map, the follow and
   * the narration's place. */
  documentReady(): void;
  receive(message: ReadalongMessage): void;
};

/** One reader document's session (`startReaderSession`). */
export type ReaderSession = {
  /** Sends to the document, holding messages until it says `ready`. */
  channel: HostChannel;
  /** A message from the document, already checked (`parseReaderMessage`). */
  receive(message: ReaderMessage): void;
  /** Stops the start timeout; the session takes no more messages. */
  end(): void;
};

/**
 * The session setup both reader hosts share (fe#172; the web's iframe, the app's WebView):
 * the channel, the start timeout (`READER_START_MS`, then a `ReaderStartError`) and what each
 * message from the document does. `ready` clears the timeout, runs the host's own `onReady`
 * (the web reopens a book a reloaded frame lost, the app starts a chunked transfer), sends
 * what waited, then tells the read-along side (`readalong.documentReady`); `csp` is logged;
 * `seek`, `following` and `readalong` go to the read-along side; anything else to `observe`
 * (the host's own bookkeeping), then the screen's `onMessage`. The callbacks are read when
 * a message comes (`callbacks()`, the host's latest props).
 */
export function startReaderSession({
  post,
  callbacks,
  onReady,
  observe,
  readalong,
}: {
  post: (message: HostMessage, transfer: Transferable[]) => void;
  callbacks: () => Pick<ReaderHostProps, 'onMessage' | 'onLoadError'>;
  onReady?: () => void;
  observe?: (message: ReaderHostEvent) => void;
  readalong?: ReadalongLink;
}): ReaderSession {
  let ended = false;
  const channel = createHostChannel(post);
  const starting = setTimeout(
    () => callbacks().onLoadError(new ReaderStartError()),
    READER_START_MS,
  );
  return {
    channel,
    receive(message) {
      if (ended) return;
      switch (message.type) {
        case 'ready':
          clearTimeout(starting);
          onReady?.();
          channel.ready();
          readalong?.documentReady();
          return;
        case 'csp':
          // A load the reader's policy blocked (an EPUB's beacon, script or font).
          console.warn('[reader] blocked by CSP:', message.directive, message.blocked);
          return;
        case 'seek':
        case 'following':
        case 'readalong':
          readalong?.receive(message);
          return;
        default:
          observe?.(message);
          callbacks().onMessage(message);
      }
    },
    end() {
      ended = true;
      clearTimeout(starting);
    },
  };
}
