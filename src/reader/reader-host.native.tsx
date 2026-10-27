import { useEffect, useImperativeHandle, useRef, useState } from 'react';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

import { useLatestRef } from '@/lib/use-latest';

import { sendInChunks } from './book-chunks';
import { chunkReader, type LocalEbook, localEbook } from './ebook-file.native';
import {
  createHostChannel,
  type GotoTarget,
  type HostChannel,
  type HostMessage,
  parseReaderMessage,
  type ReaderMessage,
  type ReaderPlace,
} from './protocol';
import { READER_START_MS, type ReaderHostProps, ReaderStartError } from './reader-host-types';
import { READER_HTML } from './reader-html.native';

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

/** How many times the WebView's content process may die in one reader session before the
 * reader gives up (`ReaderStartError`, with Try again) instead of reloading for good. */
export const MAX_RELOADS = 3;

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
 * file path. When the WebView's content process dies (memory pressure), the WebView is
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
  theme,
  fontScale,
  title,
  onMessage,
  onLoadError,
  ref,
}: ReaderHostProps) {
  const web = useRef<WebView>(null);
  const channel = useRef<HostChannel | null>(null);
  const latest = useLatestRef({ api, at, theme, fontScale, name, onMessage, onLoadError });
  // The WebView's life: a new one after its content process died.
  const [generation, setGeneration] = useState(0);
  // Where the reader last was, to reopen there after a crash (else `at`).
  const lastPlace = useRef<ReaderPlace | undefined>(undefined);
  // The book's local file, found once per book.
  const book = useRef<Promise<LocalEbook | null> | null>(null);
  // What the WebView's messages are handed to (this generation's session).
  const received = useRef<(message: ReaderMessage) => void>(() => {});

  useImperativeHandle(
    ref,
    () => ({
      goto: (target: GotoTarget) => channel.current?.send({ type: 'goto', ...target }),
      next: () => channel.current?.send({ type: 'next' }),
      prev: () => channel.current?.send({ type: 'prev' }),
    }),
    [],
  );

  // The book's file, fetched into the cache when it is not on the device: started at once,
  // while the WebView loads. A failure is said at once (null to whoever waits on it).
  useEffect(() => {
    const abort = new AbortController();
    lastPlace.current = undefined;
    book.current = localEbook({
      api: latest.current.api,
      connectionId,
      libraryId,
      path,
      size: ebookSize,
      signal: abort.signal,
    }).catch((e: unknown) => {
      if (!abort.signal.aborted) latest.current.onLoadError(e);
      return null;
    });
    return () => abort.abort();
  }, [connectionId, libraryId, path, ebookSize, latest]);

  // One reader session per WebView: the channel, the start timeout and the transfers.
  useEffect(() => {
    let closed = false;
    // Each `ready` starts a transfer; a newer one (the document reloaded) stops the last.
    let transfer = 0;
    const session = createHostChannel((message: HostMessage) =>
      web.current?.postMessage(JSON.stringify(message)),
    );
    channel.current = session;
    const starting = setTimeout(
      () => latest.current.onLoadError(new ReaderStartError()),
      READER_START_MS,
    );
    const sendBook = async () => {
      const id = ++transfer;
      const stale = () => closed || id !== transfer;
      const file = await book.current;
      if (!file || stale()) return;
      const { at: first, theme: look, fontScale: scale, name: bookName } = latest.current;
      try {
        await sendInChunks(
          file.size,
          { name: bookName, at: lastPlace.current ?? first, theme: look, fontScale: scale },
          chunkReader(file.uri),
          (message) => session.send(message),
          stale,
        );
      } catch (e) {
        if (!stale()) latest.current.onLoadError(e);
      }
    };
    received.current = (message) => {
      switch (message.type) {
        case 'ready':
          clearTimeout(starting);
          session.ready();
          void sendBook();
          return;
        case 'csp':
          // A load the reader's policy blocked (an EPUB's beacon, script or font).
          console.warn('[reader] blocked by CSP:', message.directive, message.blocked);
          return;
        case 'progress':
          lastPlace.current = { cfi: message.cfi, fraction: message.fraction };
          latest.current.onMessage(message);
          return;
        default:
          latest.current.onMessage(message);
      }
    };
    return () => {
      closed = true;
      clearTimeout(starting);
      received.current = () => {};
      channel.current = null;
    };
  }, [libraryId, path, generation, latest]);

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

  // The content process died (iOS) or the renderer is gone (Android): a new WebView, up to
  // MAX_RELOADS times; then the reader says it could not start.
  const reloads = useRef(0);
  const reload = () => {
    if (reloads.current >= MAX_RELOADS) {
      latest.current.onLoadError(new ReaderStartError());
      return;
    }
    reloads.current++;
    setGeneration((n) => n + 1);
  };

  return (
    <WebView
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
      style={{ flex: 1, backgroundColor: background }}
    />
  );
}
