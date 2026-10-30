/**
 * @jest-environment jsdom
 */

import { render, waitFor } from '@testing-library/react-native';
import { act, type ReactNode } from 'react';

import type { ApiClient } from '@/api/client';

import { READER_START_MS, type ReaderReadalongProps, ReaderStartError } from './reader-host-types';
import { READER_URL, ReaderHost } from './reader-host.web';

// A book's download (the store and the web engine have their own tests): the host reads
// the EPUB from it when it holds one.
const mockDownloaded = jest.fn((_ref: unknown): unknown => undefined);
const mockReadFile = jest.fn(async (_uri: string): Promise<ArrayBuffer | null> => null);
jest.mock('@/downloads/store', () => ({
  downloadedEntryOf: (ref: unknown) => mockDownloaded(ref),
}));
jest.mock('@/downloads/engine', () => ({
  engine: { readFile: (uri: string) => mockReadFile(uri) },
}));

// The web host's own seams (jest runs the native platform, so the web file is imported
// directly): the sandboxed frame, the book fetched by the host, a failed fetch reported;
// then, in a real page, what passes between the host and its frame.

const theme = { scheme: 'light', background: '#ffffff', foreground: '#111111' } as const;

function mount(api: Partial<ApiClient>, onLoadError = jest.fn()) {
  return render(
    <ReaderHost
      api={api as ApiClient}
      connectionId="c1"
      ebookSize={4}
      libraryId={1}
      path="A/Book"
      name="Book"
      theme={theme}
      fontScale={1}
      title="Reader"
      onMessage={jest.fn()}
      onLoadError={onLoadError}
    />,
  );
}

describe('ReaderHost (web)', () => {
  it('frames the reader document sandboxed, same-origin, with no referrer', async () => {
    const api = { ebook: jest.fn(() => new Promise<ArrayBuffer>(() => {})) };
    const view = await mount(api);
    const frame = view.toJSON() as { type: string; props: Record<string, unknown> };
    expect(frame.type).toBe('iframe');
    expect(frame.props.src).toBe(READER_URL);
    expect(READER_URL).toMatch(/\/reader\.html$/);
    expect(frame.props.sandbox).toBe('allow-scripts allow-same-origin');
    expect(frame.props.referrerPolicy).toBe('no-referrer');
    expect(api.ebook).toHaveBeenCalledWith(1, 'A/Book', expect.any(AbortSignal));
  });

  it("reads a downloaded book's EPUB from its download, fetching nothing", async () => {
    const saved = new ArrayBuffer(8);
    mockDownloaded.mockReturnValueOnce({ manifest: { ebookUri: 'https://h/web/_offline/b' } });
    mockReadFile.mockResolvedValueOnce(saved);
    const host = await mountInPage();
    const posted = host.posted;
    await host.say({ type: 'ready' });
    expect(mockDownloaded).toHaveBeenCalledWith({
      connectionId: 'c1',
      libraryId: 1,
      path: 'A/Book',
    });
    expect(mockReadFile).toHaveBeenCalledWith('https://h/web/_offline/b');
    expect(host.ebook).not.toHaveBeenCalled();
    expect((posted.mock.calls[0]?.[0] as { book: ArrayBuffer }).book).toBe(saved);
    await host.unmount();
  });

  it('fetches the book when its download holds no EPUB (or it cannot be read)', async () => {
    mockDownloaded.mockReturnValueOnce({ manifest: { ebookUri: 'https://h/web/_offline/b' } });
    mockReadFile.mockRejectedValueOnce(new Error('cache gone'));
    const host = await mountInPage();
    await host.say({ type: 'ready' });
    expect(host.ebook).toHaveBeenCalledTimes(1);
    expect(host.types()).toEqual(['open']);
    await host.unmount();
  });

  it('reports a book it could not fetch', async () => {
    const failure = new Error('404');
    const onLoadError = jest.fn();
    await mount({ ebook: jest.fn(() => Promise.reject(failure)) }, onLoadError);
    await waitFor(() => expect(onLoadError).toHaveBeenCalledWith(failure));
  });
});

// The app has no react-dom types (@types/react-dom is not a dependency): the two calls used.
const { createRoot } = jest.requireActual<{
  createRoot: (container: Element) => { render(children: ReactNode): void; unmount(): void };
}>('react-dom/client');

/** The host in a real page (react-dom): its frame has a window, so the reader's messages can
 * come from it and what the host posts to it can be watched. */
async function mountInPage({
  ebook = jest.fn(async () => new ArrayBuffer(4)),
  onMessage = jest.fn(),
  onLoadError = jest.fn(),
  onReopen = jest.fn(),
  readalong = {},
  placeKnown,
}: {
  ebook?: jest.Mock;
  onMessage?: jest.Mock;
  onLoadError?: jest.Mock;
  onReopen?: jest.Mock;
  readalong?: ReaderReadalongProps;
  placeKnown?: boolean;
} = {}) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const draw = (known: boolean | undefined) =>
    root.render(
      <ReaderHost
        api={{ ebook } as unknown as ApiClient}
        connectionId="c1"
        ebookSize={4}
        libraryId={1}
        path="A/Book"
        name="Book"
        theme={theme}
        fontScale={1}
        title="Reader"
        onMessage={onMessage}
        onLoadError={onLoadError}
        onReopen={onReopen}
        placeKnown={known}
        at={{ cfi: 'epubcfi(/6/2!/4/2)' }}
        {...readalong}
      />,
    );
  await act(async () => {
    draw(placeKnown);
  });
  /** The screen now knows where the book opens. */
  const placeFound = () =>
    act(async () => {
      draw(true);
    });
  const reader = container.querySelector('iframe')!.contentWindow!;
  const posted = jest.spyOn(reader, 'postMessage').mockImplementation(() => {});
  const say = (data: unknown, source: Window = reader) =>
    act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', { data, origin: window.location.origin, source }),
      );
    });
  const types = () => posted.mock.calls.map(([m]) => (m as { type: string }).type);
  const unmount = () =>
    act(async () => {
      root.unmount();
      container.remove();
    });
  return { ebook, onMessage, onLoadError, onReopen, say, types, unmount, posted, placeFound };
}

describe('ReaderHost (web) in a page', () => {
  it('opens the book once when it arrives before the reader is ready', async () => {
    const host = await mountInPage();
    await host.say({ type: 'ready' });
    expect(host.ebook).toHaveBeenCalledTimes(1);
    expect(host.types()).toEqual(['open']);
    await host.unmount();
  });

  it('fetches the book at once, and opens it only once where it opens is known (fe#164)', async () => {
    const host = await mountInPage({ placeKnown: false });
    await host.say({ type: 'ready' });
    expect(host.ebook).toHaveBeenCalledTimes(1);
    expect(host.types()).toEqual([]);
    await host.placeFound();
    expect(host.types()).toEqual(['open']);
    expect(host.posted.mock.calls[0]?.[0]).toMatchObject({ at: { cfi: 'epubcfi(/6/2!/4/2)' } });
    await host.unmount();
  });

  it('fetches the book again when the reader reloads after having it', async () => {
    const host = await mountInPage();
    await host.say({ type: 'ready' });
    await host.say({ type: 'ready' });
    expect(host.ebook).toHaveBeenCalledTimes(2);
    expect(host.types()).toEqual(['open', 'open']);
    await host.unmount();
  });

  it('tells the screen the reader is opening again when it reloads, not at its first ready', async () => {
    const host = await mountInPage();
    await host.say({ type: 'ready' });
    expect(host.onReopen).not.toHaveBeenCalled();
    await host.say({ type: 'ready' });
    expect(host.onReopen).toHaveBeenCalledTimes(1);
    await host.unmount();
  });

  it('hands the screen what the reader frame says, and nothing from elsewhere', async () => {
    const host = await mountInPage();
    await host.say({ type: 'escape' }, window);
    expect(host.onMessage).not.toHaveBeenCalled();
    await host.say({ type: 'escape' });
    expect(host.onMessage).toHaveBeenCalledWith({ type: 'escape' });
    await host.unmount();
  });

  it('reports a reader document that never starts, and not one that did', async () => {
    jest.useFakeTimers();
    try {
      const waiting = () => new Promise<ArrayBuffer>(() => {});
      const silent = await mountInPage({ ebook: jest.fn(waiting) });
      const started = await mountInPage({ ebook: jest.fn(waiting) });
      await started.say({ type: 'ready' });
      await act(async () => {
        jest.advanceTimersByTime(READER_START_MS);
      });
      expect(silent.onLoadError).toHaveBeenCalledWith(expect.any(ReaderStartError));
      expect(started.onLoadError).not.toHaveBeenCalled();
      await silent.unmount();
      await started.unmount();
    } finally {
      jest.useRealTimers();
    }
  });
});

// Read-along (Bridge Phase 3c) in the web host: the map goes whole (structured clone), after
// `ready`, to every document the frame loads; what the reader says goes to the callbacks.
describe('ReaderHost (web) read-along', () => {
  const map = {
    sections: [{ href: 'ch1.xhtml', spans: [{ cfi: 'epubcfi(/6/4!/4/2)', start: 1, end: 2 }] }],
  };

  it('sends the map, the place and follow once ready, and again to a reloaded frame', async () => {
    const onSeek = jest.fn();
    const onFollowing = jest.fn();
    const onReadalongState = jest.fn();
    const host = await mountInPage({
      readalong: {
        readalongMap: map,
        readalongPosition: () => ({ t: 3, rate: 1, playing: false }),
        followNarration: true,
        onSeek,
        onFollowing,
        onReadalongState,
      },
    });
    expect(host.posted).not.toHaveBeenCalled();
    await host.say({ type: 'ready' });
    const sent = () => host.posted.mock.calls.map(([m]) => m);
    expect(sent()).toContainEqual({ type: 'readalong', map });
    expect(sent()).toContainEqual({ type: 'position', t: 3, rate: 1, playing: false });
    expect(host.types().filter((t) => t !== 'open')).toEqual(['readalong', 'position', 'follow']);
    await host.say({ type: 'readalong', state: 'ok', unresolved: 0 });
    await host.say({ type: 'seek', t: 12.5 });
    await host.say({ type: 'following', value: false });
    expect(onReadalongState).toHaveBeenCalledWith({ state: 'ok', unresolved: 0 });
    expect(onSeek).toHaveBeenCalledWith(12.5);
    expect(onFollowing).toHaveBeenCalledWith(false);
    // None of them reach the screen's messages.
    expect(host.onMessage).not.toHaveBeenCalled();
    // A reloaded frame gets the map again; it had stopped following, so no follow.
    host.posted.mockClear();
    await host.say({ type: 'ready' });
    expect(host.types().filter((t) => t !== 'open')).toEqual(['readalong', 'position']);
    await host.unmount();
  });
});
