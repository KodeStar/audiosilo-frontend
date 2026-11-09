import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { WebView as BaseWebView, type WebViewMessageEvent } from 'react-native-webview';

import { downloadedEntryOf } from '@/downloads/store';
import { contentKey } from '@/lib/content-key';
import { useLatestRef } from '@/lib/use-latest';
import { whenActive } from '@/lib/when-active';

import { sendInChunks } from './book-chunks';
import { chunkReader, identifyEbook, type LocalEbook, localEbook } from './ebook-file.native';
import {
  type HostChannel,
  type HostMessage,
  parseReaderMessage,
  type ReaderMessage,
  type ReaderPlace,
} from './protocol';
import { type ReaderHostProps, ReaderStartError } from './reader-host-types';
import { READER_HTML } from './reader-html.native';
import { startReaderSession } from './reader-session';
import { usePlaceGate } from './use-place-gate';
import { useReaderControls } from './use-reader-controls';
import { useReaderReadalong } from './use-reader-readalong';

// react-native-webview 14 types its component `WebView<P = undefined>` with props
// `WebViewProps & P`, and `& undefined` makes every prop `never`: instantiate it with no
// extra props instead (a type-only instantiation; at runtime this is the same component).
const ReaderWebView = BaseWebView<object>;
type ReaderWebViewRef = BaseWebView<object>;

/**
 * The reader document's base URL: it gives the document an origin, without which foliate's
 * section frames get opaque `blob:null` URLs that never open (Android's renderer dies on
 * them). `.invalid` is reserved, so nothing can ever answer there, and the document's CSP
 * refuses every load anyway (`connect-src 'none'`).
 */
export const READER_BASE_URL = 'https://reader.audiosilo.invalid/';

/** The navigations the reader WebView may make: its document and foliate's section frames
 * (`about:blank`, then a `blob:` of the document's own origin). Everything else is refused
 * here, never handed on: a URL outside `originWhitelist` is opened by the system
 * (`Linking.openURL`) instead, so the whitelist admits everything and this decides. */
export function allowNavigation(url: string): boolean {
  return (
    url === READER_BASE_URL ||
    url === 'about:blank' ||
    url.startsWith(`blob:${READER_BASE_URL.slice(0, -1)}/`)
  );
}

/** How many times in a row the WebView's content process may die before the reader gives
 * up (`ReaderStartError`, with Try again) instead of reloading for good. */
export const MAX_RELOADS = 3;

/** How long a WebView must have shown the book (since its `opened`) for its death not to
 * count against MAX_RELOADS: a book that stayed open that long was taken by the system
 * (memory pressure, the app away), not failing to open. */
export const STABLE_MS = 60_000;

/** A message from the WebView: JSON from the reader document, checked field by field
 * (`parseReaderMessage`). On Android the bridge object reaches the book's frames too. */
export function readNativeMessage(data: string): ReaderMessage | null {
  try {
    return parseReaderMessage(JSON.parse(data));
  } catch {
    return null;
  }
}

/**
 * The app's reader host (Bridge Phase 3b-2): the reader document (`reader-html.native.ts`)
 * as a WebView's HTML source, with every file access setting off and a CSP that allows no
 * request at all. The host finds the book's EPUB as a local file (its download, else the
 * reader's cache file, `ebook-file.native.ts`) and posts it in base64 chunks once the
 * reader says `ready` (`book-chunks.ts`); the reader never sees a token, an API URL or a
 * file path. What each message does is the session both hosts share (`startReaderSession`),
 * the read-along map (in pieces when large), place and follow too (`useReaderReadalong`). When the WebView's content process dies (memory pressure), the WebView is
 * made again and the book reopens where the reader last was.
 */
export function ReaderHost({
  api,
  connectionId,
  libraryId,
  path,
  ebookSize,
  name,
  at,
  placeKnown = true,
  theme,
  fontScale,
  title,
  onMessage,
  onLoadError,
  onReopen,
  onFetch,
  onEbook,
  ref,
  ...readalongProps
}: ReaderHostProps) {
  const web = useRef<ReaderWebViewRef>(null);
  const placeGate = usePlaceGate(placeKnown);
  const channel = useRef<HostChannel | null>(null);
  const latest = useLatestRef({
    api,
    at,
    ebookSize,
    theme,
    fontScale,
    name,
    onMessage,
    onLoadError,
    onReopen,
    onFetch,
    onEbook,
  });
  // The WebView's life: a new one after its content process died.
  const [generation, setGeneration] = useState(0);
  // Where the reader last was, to reopen there after a crash (else `at`).
  const lastPlace = useRef<ReaderPlace | undefined>(undefined);
  // When this WebView last said `opened` (null before it did), for the reload budget.
  const openedAt = useRef<number | null>(null);
  // The book's local file, selected for each reader document.
  const book = useRef<Promise<LocalEbook | null> | null>(null);
  // What the WebView's messages are handed to (this generation's session).
  const received = useRef<(message: ReaderMessage) => void>(() => {});
  // Ends this generation's session: on a new WebView, on unmount, and at once when the
  // WebView dies (its new one may wait for the app to come back).
  const endSession = useRef(() => {});

  const bookKey = contentKey(connectionId, libraryId, path);
  const [selected, setSelected] = useState<{
    book: string;
    generation: number;
    sha256: string;
  } | null>(null);
  const ebookSha =
    selected?.book === bookKey && selected.generation === generation ? selected.sha256 : null;
  const withholdMap = !!onEbook && ebookSha !== readalongProps.readalongEbookSha256;
  const readalong = useReaderReadalong(
    channel,
    {
      ...readalongProps,
      readalongMap: withholdMap ? null : readalongProps.readalongMap,
    },
    true,
    withholdMap && !!readalongProps.readalongMap,
  );
  useReaderControls(channel, ref, theme, fontScale, readalong);

  useEffect(() => {
    lastPlace.current = undefined;
  }, [bookKey]);

  // The book's file, fetched into the cache when it is not on the device: started at once,
  // while the WebView loads. A failure is said at once (null to whoever waits on it). A
  // new document selects and identifies the file again: its path may have been replaced.
  useEffect(() => {
    const abort = new AbortController();
    const publishEbook = latest.current.onEbook;
    const saved = downloadedEntryOf({ connectionId, libraryId, path })?.manifest.ebookUri;
    const find = (saved?: string) =>
      localEbook({
        api: latest.current.api,
        connectionId,
        libraryId,
        path,
        size: latest.current.ebookSize,
        // The download's copy, when the book is downloaded with its EPUB.
        saved,
        signal: abort.signal,
        onFetch: () => latest.current.onFetch?.(),
      });
    book.current = find(saved)
      .then(async (selected) => {
        if (!publishEbook) return selected;
        let file = selected;
        let identity;
        try {
          identity = await identifyEbook(file, file.uri === saved ? 'download' : 'server');
        } catch (error) {
          if (file.uri !== saved || abort.signal.aborted) throw error;
          file = await find();
          identity = await identifyEbook(file, 'server');
        }
        if (abort.signal.aborted) return null;
        setSelected({ book: bookKey, generation, sha256: identity.sha256 });
        publishEbook(identity);
        return { ...file, size: identity.size };
      })
      .catch((e: unknown) => {
        if (!abort.signal.aborted) latest.current.onLoadError(e);
        return null;
      });
    return () => abort.abort();
  }, [connectionId, libraryId, path, bookKey, generation, latest]);

  // One reader session per WebView: the channel, the start timeout and the transfers.
  useEffect(() => {
    let closed = false;
    // Each `ready` starts a transfer; a newer one (the document reloaded) stops the last.
    let transfer = 0;
    const session = startReaderSession({
      post: (message: HostMessage) => web.current?.postMessage(JSON.stringify(message)),
      callbacks: () => latest.current,
      onReady: () => void sendBook(),
      observe: (message) => {
        if (message.type === 'progress') {
          lastPlace.current = { cfi: message.cfi, fraction: message.fraction };
        } else if (message.type === 'opened') {
          openedAt.current = Date.now();
        }
      },
      readalong,
    });
    channel.current = session.channel;
    const sendBook = async () => {
      const id = ++transfer;
      const stale = () => closed || id !== transfer;
      const file = await book.current;
      // The file is in: the book goes over once the screen knows where it opens.
      await placeGate();
      if (!file || stale()) return;
      const { at: first, theme: look, fontScale: scale, name: bookName } = latest.current;
      try {
        await sendInChunks(
          file.size,
          { name: bookName, at: lastPlace.current ?? first, theme: look, fontScale: scale },
          chunkReader(file.uri),
          (message) => session.channel.send(message),
          stale,
        );
      } catch (e) {
        if (!stale()) latest.current.onLoadError(e);
      }
    };
    received.current = session.receive;
    const end = () => {
      closed = true;
      session.end();
      received.current = () => {};
      channel.current = null;
    };
    endSession.current = end;
    return end;
  }, [libraryId, path, generation, latest, readalong, placeGate]);

  // The content process died (iOS) or the renderer is gone (Android): a new WebView, up to
  // MAX_RELOADS times in a row; then the reader says it could not start. A WebView that
  // showed the book for STABLE_MS was taken by the system, so its death starts the count
  // again. One that dies while the app is in the background is made again once the app is
  // back: made away, it may get no running content process and its start timeout runs out.
  const reloads = useRef(0);
  // A new WebView waiting for the app to come back (its cancel); a reader closed meanwhile
  // makes none.
  const deferred = useRef<(() => void) | null>(null);
  useEffect(() => () => deferred.current?.(), []);
  const reload = () => {
    endSession.current();
    if (openedAt.current !== null && Date.now() - openedAt.current >= STABLE_MS) {
      reloads.current = 0;
    }
    openedAt.current = null;
    if (reloads.current >= MAX_RELOADS) {
      latest.current.onLoadError(new ReaderStartError());
      return;
    }
    reloads.current++;
    latest.current.onReopen?.();
    deferred.current?.();
    deferred.current = null;
    if (AppState.currentState === 'background') {
      deferred.current = whenActive(() => {
        deferred.current = null;
        setGeneration((n) => n + 1);
      });
    } else {
      setGeneration((n) => n + 1);
    }
  };

  return (
    <ReaderWebView
      key={generation}
      ref={web}
      source={{ html: READER_HTML, baseUrl: READER_BASE_URL }}
      originWhitelist={['*']}
      onShouldStartLoadWithRequest={(request) => allowNavigation(request.url)}
      onMessage={(event: WebViewMessageEvent) => {
        const message = readNativeMessage(event.nativeEvent.data);
        if (message) received.current(message);
      }}
      onContentProcessDidTerminate={reload}
      onRenderProcessGone={reload}
      javaScriptEnabled
      domStorageEnabled={false}
      allowFileAccess={false}
      allowFileAccessFromFileURLs={false}
      allowUniversalAccessFromFileURLs={false}
      allowsLinkPreview={false}
      setSupportMultipleWindows={false}
      javaScriptCanOpenWindowsAutomatically={false}
      mediaPlaybackRequiresUserAction
      cacheEnabled={false}
      bounces={false}
      overScrollMode="never"
      webviewDebuggingEnabled={__DEV__}
      accessibilityLabel={title}
      style={{ flex: 1, backgroundColor: theme.background }}
    />
  );
}
