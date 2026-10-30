import { act, render, waitFor } from '@testing-library/react-native';
import type { Ref } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import type { ApiClient } from '@/api/client';

import { CHUNK_BYTES } from './book-chunks';
import type { HostMessage } from './protocol';
import {
  READER_START_MS,
  type ReaderHostHandle,
  type ReaderHostProps,
  ReaderStartError,
} from './reader-host-types';

// The app's host (Bridge Phase 3b-2), with the WebView and the book's file faked: what it
// gives the WebView, what it posts and when, and how it comes back from a crash.

type FakeWebViewProps = Record<string, unknown> & {
  onMessage: (e: { nativeEvent: { data: string } }) => void;
  onShouldStartLoadWithRequest: (r: { url: string }) => boolean;
  onContentProcessDidTerminate: () => void;
  onRenderProcessGone: () => void;
  ref?: Ref<{ postMessage(data: string): void }>;
};
/** Every WebView mounted (a crash makes a new one), with what was posted to each. */
const mockViews: { props: FakeWebViewProps; posted: HostMessage[] }[] = [];
jest.mock('react-native-webview', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  function WebView(props: FakeWebViewProps) {
    const view = React.useRef<{ props: FakeWebViewProps; posted: HostMessage[] } | null>(null);
    if (!view.current) {
      view.current = { props, posted: [] };
      mockViews.push(view.current);
    }
    view.current.props = props;
    React.useImperativeHandle(props.ref, () => ({
      postMessage: (data: string) => view.current!.posted.push(JSON.parse(data) as HostMessage),
    }));
    return null;
  }
  return { WebView };
});

const mockLocalEbook = jest.fn(async (_a: unknown) => ({
  uri: 'file:///cache/book.epub',
  size: CHUNK_BYTES + 5,
}));
jest.mock('./ebook-file.native', () => ({
  localEbook: (a: unknown) => mockLocalEbook(a),
  chunkReader: (uri: string) => async (position: number, length: number) =>
    `${uri}@${position}+${length}`,
}));
jest.mock('./reader-html.native', () => ({ READER_HTML: '<!doctype html><title>Reader</title>' }));
// A book's download (the store has its own tests): the host hands its EPUB to the file lookup.
const mockDownloaded = jest.fn((_ref: unknown): unknown => undefined);
jest.mock('@/downloads/store', () => ({
  downloadedEntryOf: (ref: unknown) => mockDownloaded(ref),
}));

/* eslint-disable import/first */
import {
  allowNavigation,
  MAX_RELOADS,
  READER_BASE_URL,
  ReaderHost,
  readNativeMessage,
  STABLE_MS,
} from './reader-host.native';
/* eslint-enable import/first */

const theme = { scheme: 'light', background: '#ffffff', foreground: '#111111' } as const;

async function mount({
  onMessage = jest.fn(),
  onLoadError = jest.fn(),
  onReopen = jest.fn(),
  placeKnown = undefined as boolean | undefined,
} = {}) {
  const handle: { current: ReaderHostHandle | null } = { current: null };
  const host = (ebookSize: number, known = placeKnown) => (
    <ReaderHost
      api={{} as ApiClient}
      connectionId="c1"
      libraryId={2}
      path="A/Book"
      ebookSize={ebookSize}
      name="Book"
      at={{ cfi: 'epubcfi(/6/2!/4)', fraction: 0.1 }}
      placeKnown={known}
      theme={theme}
      fontScale={1}
      title="Reader"
      onMessage={onMessage}
      onLoadError={onLoadError}
      onReopen={onReopen}
      ref={handle}
    />
  );
  const view = await render(host(CHUNK_BYTES + 5));
  /** The screen renders the host again with the server's new size of the ebook. */
  const resize = (ebookSize: number) => view.rerender(host(ebookSize));
  /** The screen now knows where the book opens. */
  const placeFound = () => view.rerender(host(CHUNK_BYTES + 5, true));
  return { onMessage, onLoadError, onReopen, handle, resize, placeFound, unmount: view.unmount };
}

const latest = () => mockViews[mockViews.length - 1];
const say = (message: object, view = latest()) =>
  act(async () => {
    view.props.onMessage({ nativeEvent: { data: JSON.stringify(message) } });
  });
const openedMessage = { type: 'opened', title: 'Book', toc: [], rtl: false };

/** `Date.now()` as the test sets it (the reload budget reads it), restored by `restore`. */
function fakeClock() {
  let now = 1_000_000;
  const spy = jest.spyOn(Date, 'now').mockImplementation(() => now);
  return { pass: (ms: number) => (now += ms), restore: () => spy.mockRestore() };
}

/** The app's state as the test moves it, heard by whoever listens (the jest preset's
 * AppState never changes), restored by `restore`. */
function fakeAppState() {
  const app = AppState as { currentState: AppStateStatus };
  const was = app.currentState;
  let listeners: ((state: AppStateStatus) => void)[] = [];
  const spy = jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, fn) => {
    const listener = fn as (state: AppStateStatus) => void;
    listeners.push(listener);
    const remove = () => (listeners = listeners.filter((l) => l !== listener));
    return { remove } as unknown as ReturnType<typeof AppState.addEventListener>;
  });
  return {
    change: (state: AppStateStatus) =>
      act(async () => {
        app.currentState = state;
        [...listeners].forEach((l) => l(state));
      }),
    listening: () => listeners.length,
    restore: () => {
      spy.mockRestore();
      app.currentState = was;
    },
  };
}

beforeEach(() => {
  mockViews.length = 0;
  jest.clearAllMocks();
});

describe('ReaderHost (app)', () => {
  it('loads the reader as an HTML source with every file access setting off', async () => {
    await mount();
    const { props } = latest();
    expect(props.source).toEqual({ html: expect.any(String), baseUrl: READER_BASE_URL });
    expect(props.allowFileAccess).toBe(false);
    expect(props.allowFileAccessFromFileURLs).toBe(false);
    expect(props.allowUniversalAccessFromFileURLs).toBe(false);
    expect(props.setSupportMultipleWindows).toBe(false);
    expect(props.javaScriptCanOpenWindowsAutomatically).toBe(false);
    // The whitelist admits all: a miss would hand the url to the system (Linking.openURL).
    expect(props.originWhitelist).toEqual(['*']);
    expect(props).not.toHaveProperty('allowingReadAccessToURL');
    expect(mockLocalEbook).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: 'c1',
        libraryId: 2,
        path: 'A/Book',
        size: CHUNK_BYTES + 5,
      }),
    );
  });

  it('holds the book until the reader is ready, then posts open and every chunk in order', async () => {
    await mount();
    await waitFor(() => expect(mockLocalEbook).toHaveBeenCalled());
    expect(latest().posted).toEqual([]);
    await say({ type: 'ready' });
    await waitFor(() => expect(latest().posted).toHaveLength(3));
    expect(latest().posted).toEqual([
      {
        type: 'open',
        name: 'Book',
        at: { cfi: 'epubcfi(/6/2!/4)', fraction: 0.1 },
        theme,
        fontScale: 1,
        size: CHUNK_BYTES + 5,
        chunks: 2,
      },
      { type: 'chunk', seq: 0, data: `file:///cache/book.epub@0+${CHUNK_BYTES}` },
      { type: 'chunk', seq: 1, data: `file:///cache/book.epub@${CHUNK_BYTES}+5` },
    ]);
  });

  it('finds the file at once, and posts the book only once where it opens is known (fe#164)', async () => {
    const { placeFound } = await mount({ placeKnown: false });
    await waitFor(() => expect(mockLocalEbook).toHaveBeenCalled());
    await say({ type: 'ready' });
    await act(async () => {});
    expect(latest().posted).toEqual([]);
    await act(async () => {
      await placeFound();
    });
    await waitFor(() => expect(latest().posted).toHaveLength(3));
    expect(latest().posted[0]).toMatchObject({ type: 'open', at: { cfi: 'epubcfi(/6/2!/4)' } });
  });

  it('holds page turns until the reader is ready', async () => {
    const { handle } = await mount();
    await act(async () => handle.current?.next());
    expect(latest().posted).toEqual([]);
    await say({ type: 'ready' });
    await waitFor(() => expect(latest().posted[0]).toEqual({ type: 'next' }));
  });

  it('hands the file lookup the download’s EPUB when the book is downloaded with one', async () => {
    mockDownloaded.mockReturnValueOnce({ manifest: { ebookUri: 'file:///docs/c1/2/A/book.epub' } });
    await mount();
    expect(mockDownloaded).toHaveBeenCalledWith({
      connectionId: 'c1',
      libraryId: 2,
      path: 'A/Book',
    });
    expect(mockLocalEbook).toHaveBeenCalledWith(
      expect.objectContaining({ saved: 'file:///docs/c1/2/A/book.epub' }),
    );
  });

  it('keeps the file it is getting when the server’s size changes (the next open fetches it)', async () => {
    // The lookup in flight fails once aborted, as the real one does.
    let arrive: (file: { uri: string; size: number }) => void = () => {};
    mockLocalEbook.mockImplementationOnce(
      (a) =>
        new Promise((resolve, reject) => {
          arrive = resolve;
          (a as { signal: AbortSignal }).signal.addEventListener('abort', () =>
            reject(new Error('aborted')),
          );
        }),
    );
    const { onLoadError, resize } = await mount();
    await say({ type: 'ready' });
    // The screen's book read again on resume, with the server's EPUB replaced meanwhile.
    await resize(CHUNK_BYTES + 9);
    await act(async () => arrive({ uri: 'file:///cache/book.epub', size: CHUNK_BYTES + 5 }));
    await waitFor(() => expect(latest().posted).toHaveLength(3));
    expect(mockLocalEbook).toHaveBeenCalledTimes(1);
    expect(onLoadError).not.toHaveBeenCalled();
  });

  it('reopens where the reader last was in a new WebView after the content process dies', async () => {
    const { onMessage, onReopen } = await mount();
    await say({ type: 'ready' });
    await say({ type: 'progress', cfi: 'epubcfi(/6/8!/4/2)', fraction: 0.4, sectionLabel: 'II' });
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'progress' }));
    const first = latest();
    await act(async () => first.props.onContentProcessDidTerminate());
    expect(mockViews).toHaveLength(2);
    // The screen hears it, to wait for the book to show again.
    expect(onReopen).toHaveBeenCalledTimes(1);
    await say({ type: 'ready' });
    await waitFor(() => expect(latest().posted[0]).toMatchObject({ type: 'open' }));
    expect(latest().posted[0]).toMatchObject({ at: { cfi: 'epubcfi(/6/8!/4/2)', fraction: 0.4 } });
    // The book's file is found once, not again for the new WebView.
    expect(mockLocalEbook).toHaveBeenCalledTimes(1);
  });

  it('gives up after the renderer dies again and again (Android), saying so', async () => {
    const { onLoadError, onReopen } = await mount();
    for (let i = 0; i <= MAX_RELOADS; i++) {
      await act(async () => latest().props.onRenderProcessGone());
    }
    expect(mockViews).toHaveLength(MAX_RELOADS + 1);
    expect(onLoadError).toHaveBeenCalledWith(expect.any(ReaderStartError));
    // Each new WebView was said; the death it gave up on was not.
    expect(onReopen).toHaveBeenCalledTimes(MAX_RELOADS);
  });

  it('counts a death within a minute of the book opening (a book that cannot stay open)', async () => {
    const clock = fakeClock();
    try {
      const { onLoadError } = await mount();
      for (let i = 0; i <= MAX_RELOADS; i++) {
        await say({ type: 'ready' });
        await say(openedMessage);
        clock.pass(STABLE_MS - 1);
        await act(async () => latest().props.onContentProcessDidTerminate());
      }
      expect(mockViews).toHaveLength(MAX_RELOADS + 1);
      expect(onLoadError).toHaveBeenCalledWith(expect.any(ReaderStartError));
    } finally {
      clock.restore();
    }
  });

  it('starts the count again when a WebView showed the book for a minute (the system took it)', async () => {
    const clock = fakeClock();
    try {
      const { onLoadError, onMessage } = await mount();
      // Deaths before the book opened use the budget up...
      for (let i = 0; i < MAX_RELOADS; i++) {
        await act(async () => latest().props.onRenderProcessGone());
      }
      // ...but a WebView that then showed the book for STABLE_MS was taken by the system,
      // however often that happens in a long read.
      for (let i = 0; i <= MAX_RELOADS; i++) {
        await say({ type: 'ready' });
        await say(openedMessage);
        clock.pass(STABLE_MS);
        await act(async () => latest().props.onContentProcessDidTerminate());
      }
      expect(mockViews).toHaveLength(2 * MAX_RELOADS + 2);
      expect(onLoadError).not.toHaveBeenCalled();
      expect(onMessage).toHaveBeenCalledWith(openedMessage);
    } finally {
      clock.restore();
    }
  });

  it('makes the new WebView once the app is back when the old one died in the background', async () => {
    const app = fakeAppState();
    try {
      const { onLoadError, onReopen, unmount } = await mount();
      await say({ type: 'ready' });
      await app.change('background');
      await act(async () => latest().props.onContentProcessDidTerminate());
      expect(onReopen).toHaveBeenCalledTimes(1);
      expect(mockViews).toHaveLength(1);
      await app.change('inactive');
      expect(mockViews).toHaveLength(1);
      await app.change('active');
      expect(mockViews).toHaveLength(2);
      await say({ type: 'ready' });
      await waitFor(() => expect(latest().posted[0]).toMatchObject({ type: 'open' }));
      // A reader closed while its new WebView waits makes none.
      await app.change('background');
      await act(async () => latest().props.onRenderProcessGone());
      expect(app.listening()).toBe(1);
      await unmount();
      expect(app.listening()).toBe(0);
      expect(onLoadError).not.toHaveBeenCalled();
    } finally {
      app.restore();
    }
  });

  it('ends a dead WebView’s session at once: its start timeout never runs out meanwhile', async () => {
    jest.useFakeTimers();
    const app = fakeAppState();
    try {
      const { onLoadError } = await mount();
      await app.change('background');
      // It dies before saying ready, its start timeout running.
      await act(async () => latest().props.onRenderProcessGone());
      await act(async () => {
        jest.advanceTimersByTime(READER_START_MS);
      });
      expect(onLoadError).not.toHaveBeenCalled();
      // The new WebView's own timeout runs from when it is made.
      await app.change('active');
      expect(mockViews).toHaveLength(2);
      await act(async () => {
        jest.advanceTimersByTime(READER_START_MS);
      });
      expect(onLoadError).toHaveBeenCalledWith(expect.any(ReaderStartError));
    } finally {
      app.restore();
      jest.useRealTimers();
    }
  });

  it('reports a book it could not get, and never posts it', async () => {
    const gone = new Error('404');
    mockLocalEbook.mockRejectedValueOnce(gone);
    const { onLoadError } = await mount();
    await waitFor(() => expect(onLoadError).toHaveBeenCalledWith(gone));
    await say({ type: 'ready' });
    expect(latest().posted).toEqual([]);
  });

  it('reports a reader document that never says ready', async () => {
    jest.useFakeTimers();
    try {
      const { onLoadError } = await mount();
      await act(async () => {
        jest.advanceTimersByTime(READER_START_MS);
      });
      expect(onLoadError).toHaveBeenCalledWith(expect.any(ReaderStartError));
    } finally {
      jest.useRealTimers();
    }
  });

  it('hands the screen the reader’s messages and drops anything malformed', async () => {
    const { onMessage } = await mount();
    await act(async () => {
      latest().props.onMessage({ nativeEvent: { data: 'not json' } });
      latest().props.onMessage({ nativeEvent: { data: '{"type":"opened","title":5}' } });
    });
    expect(onMessage).not.toHaveBeenCalled();
    await say({ type: 'escape' });
    expect(onMessage).toHaveBeenCalledWith({ type: 'escape' });
  });
});

describe('allowNavigation', () => {
  it('lets the reader document and its own section frames load', () => {
    expect(allowNavigation(READER_BASE_URL)).toBe(true);
    expect(allowNavigation('about:blank')).toBe(true);
    expect(allowNavigation('blob:https://reader.audiosilo.invalid/7ea69dbe-0c0e')).toBe(true);
  });

  it('refuses everything else: the web, files, other origins’ blobs, scripts', () => {
    for (const url of [
      'https://example.com/',
      'http://reader.audiosilo.invalid/',
      'https://reader.audiosilo.invalid.example.com/',
      'file:///data/user/0/app/files/secret',
      'blob:https://example.com/abc',
      'blob:null/abc',
      'javascript:alert(1)',
      'data:text/html,hi',
      'audiosilo://pair',
    ]) {
      expect(allowNavigation(url)).toBe(false);
    }
  });
});

describe('readNativeMessage', () => {
  it('parses the reader’s JSON field by field', () => {
    expect(readNativeMessage('{"type":"loading","value":true}')).toEqual({
      type: 'loading',
      value: true,
    });
    expect(readNativeMessage('{"type":"loading","value":"yes"}')).toBeNull();
    expect(readNativeMessage('{')).toBeNull();
    expect(readNativeMessage('null')).toBeNull();
  });
});

// Read-along (Bridge Phase 3c): the map (in pieces when large), the narration's place once a
// second, and follow go to each new WebView once it is ready; what the reader says back goes
// to the props' callbacks.
describe('ReaderHost (app) read-along', () => {
  const small = {
    sections: [{ href: 'ch1.xhtml', spans: [{ cfi: 'epubcfi(/6/4!/4/2)', start: 1, end: 2 }] }],
  };
  const large = {
    sections: [
      {
        href: 'ch1.xhtml',
        spans: Array.from({ length: 6000 }, (_, i) => ({
          cfi: `epubcfi(/6/4!/4/${2 * i + 2},/1:0,/1:40)`,
          start: i * 3,
          end: i * 3 + 2.5,
        })),
      },
    ],
  };
  const types = (view = latest()) => view.posted.map((m) => m.type);

  async function mountAlong(props: Partial<ReaderHostProps> = {}) {
    const handle: { current: ReaderHostHandle | null } = { current: null };
    const callbacks = { onSeek: jest.fn(), onFollowing: jest.fn(), onReadalongState: jest.fn() };
    let position = { t: 5, rate: 1, playing: true };
    const host = (over: Partial<ReaderHostProps>) => (
      <ReaderHost
        api={{} as ApiClient}
        connectionId="c1"
        libraryId={2}
        path="A/Book"
        ebookSize={CHUNK_BYTES + 5}
        name="Book"
        theme={theme}
        fontScale={1}
        title="Reader"
        onMessage={jest.fn()}
        onLoadError={jest.fn()}
        readalongPosition={() => position}
        {...callbacks}
        {...props}
        {...over}
        ref={handle}
      />
    );
    const view = await render(host({}));
    return {
      ...callbacks,
      handle,
      rerender: (over: Partial<ReaderHostProps>) => view.rerender(host(over)),
      setPosition: (p: typeof position) => (position = p),
      unmount: view.unmount,
    };
  }

  it('sends nothing of read-along without a map', async () => {
    await mountAlong();
    await say({ type: 'ready' });
    await waitFor(() => expect(types()).toContain('open'));
    expect(types().filter((t) => t === 'readalong' || t === 'position')).toEqual([]);
  });

  it('sends a small map whole once ready, the place, and follow when asked to follow', async () => {
    await mountAlong({ readalongMap: small, followNarration: true });
    expect(latest().posted).toEqual([]);
    await say({ type: 'ready' });
    const posted = latest().posted.filter((m) => m.type !== 'open' && m.type !== 'chunk');
    expect(posted).toEqual([
      { type: 'readalong', map: small },
      { type: 'position', t: 5, rate: 1, playing: true },
      { type: 'follow' },
    ]);
  });

  it('sends a large map in pieces of its text, which join into the map', async () => {
    await mountAlong({ readalongMap: large });
    await say({ type: 'ready' });
    const [head, ...rest] = latest().posted.filter(
      (m) => m.type === 'readalong' || m.type === 'readalongChunk',
    );
    const text = JSON.stringify(large);
    expect(text.length).toBeGreaterThan(CHUNK_BYTES);
    expect(head).toEqual({ type: 'readalong', length: text.length, chunks: rest.length });
    expect(rest.length).toBe(Math.ceil(text.length / CHUNK_BYTES));
    const joined = rest.map((m) => (m.type === 'readalongChunk' ? m.data : '')).join('');
    expect(JSON.parse(joined)).toEqual(large);
    // Not following until asked: no follow.
    expect(types()).not.toContain('follow');
  });

  it('sends the place every second while a map is in, and at once on syncPosition', async () => {
    jest.useFakeTimers();
    try {
      const along = await mountAlong({ readalongMap: small });
      await say({ type: 'ready' });
      const positions = () => latest().posted.filter((m) => m.type === 'position');
      expect(positions()).toHaveLength(1);
      along.setPosition({ t: 6, rate: 1.5, playing: true });
      await act(async () => jest.advanceTimersByTime(1000));
      expect(positions().at(-1)).toEqual({ type: 'position', t: 6, rate: 1.5, playing: true });
      along.setPosition({ t: 9, rate: 1.5, playing: false });
      await act(async () => along.handle.current?.syncPosition());
      expect(positions().at(-1)).toEqual({ type: 'position', t: 9, rate: 1.5, playing: false });
      // A place that is not one (another book playing, nonsense) is not sent.
      const count = positions().length;
      along.setPosition({ t: Number.NaN, rate: 1, playing: true });
      await act(async () => jest.advanceTimersByTime(1000));
      expect(positions()).toHaveLength(count);
      // The map goes: none is said, and the place no longer sent.
      await act(async () => along.rerender({ readalongMap: null }));
      expect(latest().posted.at(-1)).toEqual({ type: 'readalong', map: null });
      along.setPosition({ t: 20, rate: 1, playing: true });
      await act(async () => jest.advanceTimersByTime(3000));
      expect(positions()).toHaveLength(count);
    } finally {
      jest.useRealTimers();
    }
  });

  it("hands the reader's seek, following and map state to the callbacks", async () => {
    const along = await mountAlong({ readalongMap: small });
    await say({ type: 'ready' });
    await say({ type: 'readalong', state: 'ok', unresolved: 2 });
    await say({ type: 'seek', t: 31.2 });
    await say({ type: 'following', value: false });
    await say({ type: 'seek', t: -4 });
    expect(along.onReadalongState).toHaveBeenCalledWith({ state: 'ok', unresolved: 2 });
    expect(along.onSeek).toHaveBeenCalledTimes(1);
    expect(along.onSeek).toHaveBeenCalledWith(31.2);
    expect(along.onFollowing).toHaveBeenCalledWith(false);
  });

  it('a new map in an open reader is sent at once; follow() asks the reader to follow', async () => {
    const along = await mountAlong({ readalongMap: small });
    await say({ type: 'ready' });
    const other = { sections: [{ href: 'ch2.xhtml', spans: [] }] };
    await act(async () => along.rerender({ readalongMap: other }));
    expect(latest().posted).toContainEqual({ type: 'readalong', map: other });
    await act(async () => along.handle.current?.follow());
    expect(latest().posted.at(-1)).toEqual({ type: 'follow' });
  });

  it('a WebView made again gets the map and follows as the last one last said', async () => {
    await mountAlong({ readalongMap: small, followNarration: true });
    await say({ type: 'ready' });
    // The reader stopped following (the person turned the page away), then died.
    await say({ type: 'following', value: false });
    await act(async () => latest().props.onContentProcessDidTerminate());
    await waitFor(() => expect(mockViews).toHaveLength(2));
    await say({ type: 'ready' });
    expect(types()).toContain('readalong');
    expect(types()).not.toContain('follow');
    // Following again, then a death: the next one follows.
    await say({ type: 'following', value: true });
    await act(async () => latest().props.onContentProcessDidTerminate());
    await waitFor(() => expect(mockViews).toHaveLength(3));
    await say({ type: 'ready' });
    expect(types()).toContain('follow');
  });
});
