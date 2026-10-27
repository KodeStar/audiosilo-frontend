import { act, render, waitFor } from '@testing-library/react-native';
import type { Ref } from 'react';

import type { ApiClient } from '@/api/client';

import { CHUNK_BYTES } from './book-chunks';
import type { HostMessage } from './protocol';
import { READER_START_MS, type ReaderHostHandle, ReaderStartError } from './reader-host-types';

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

/* eslint-disable import/first */
import {
  allowNavigation,
  MAX_RELOADS,
  READER_BASE_URL,
  ReaderHost,
  readNativeMessage,
} from './reader-host.native';
/* eslint-enable import/first */

const theme = { scheme: 'light', background: '#ffffff', foreground: '#111111' } as const;

async function mount({ onMessage = jest.fn(), onLoadError = jest.fn() } = {}) {
  const handle: { current: ReaderHostHandle | null } = { current: null };
  await render(
    <ReaderHost
      api={{} as ApiClient}
      connectionId="c1"
      libraryId={2}
      path="A/Book"
      ebookSize={CHUNK_BYTES + 5}
      name="Book"
      at={{ cfi: 'epubcfi(/6/2!/4)', fraction: 0.1 }}
      theme={theme}
      fontScale={1}
      title="Reader"
      onMessage={onMessage}
      onLoadError={onLoadError}
      ref={handle}
    />,
  );
  return { onMessage, onLoadError, handle };
}

const latest = () => mockViews[mockViews.length - 1];
const say = (message: object, view = latest()) =>
  act(async () => {
    view.props.onMessage({ nativeEvent: { data: JSON.stringify(message) } });
  });

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

  it('holds page turns until the reader is ready', async () => {
    const { handle } = await mount();
    await act(async () => handle.current?.next());
    expect(latest().posted).toEqual([]);
    await say({ type: 'ready' });
    await waitFor(() => expect(latest().posted[0]).toEqual({ type: 'next' }));
  });

  it('reopens where the reader last was in a new WebView after the content process dies', async () => {
    const { onMessage } = await mount();
    await say({ type: 'ready' });
    await say({ type: 'progress', cfi: 'epubcfi(/6/8!/4/2)', fraction: 0.4, sectionLabel: 'II' });
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'progress' }));
    const first = latest();
    await act(async () => first.props.onContentProcessDidTerminate());
    expect(mockViews).toHaveLength(2);
    await say({ type: 'ready' });
    await waitFor(() => expect(latest().posted[0]).toMatchObject({ type: 'open' }));
    expect(latest().posted[0]).toMatchObject({ at: { cfi: 'epubcfi(/6/8!/4/2)', fraction: 0.4 } });
    // The book's file is found once, not again for the new WebView.
    expect(mockLocalEbook).toHaveBeenCalledTimes(1);
  });

  it('gives up after the renderer dies again and again (Android), saying so', async () => {
    const { onLoadError } = await mount();
    for (let i = 0; i <= MAX_RELOADS; i++) {
      await act(async () => latest().props.onRenderProcessGone());
    }
    expect(mockViews).toHaveLength(MAX_RELOADS + 1);
    expect(onLoadError).toHaveBeenCalledWith(expect.any(ReaderStartError));
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
