/**
 * @jest-environment jsdom
 */

import { render, waitFor } from '@testing-library/react-native';
import { act, type ReactNode } from 'react';

import type { ApiClient } from '@/api/client';

import { ReaderStartError } from './reader-host-types';
import { READER_START_MS, READER_URL, ReaderHost } from './reader-host.web';

// The web host's own seams (jest runs the native platform, so the web file is imported
// directly): the sandboxed frame, the book fetched by the host, a failed fetch reported;
// then, in a real page, what passes between the host and its frame.

const theme = { scheme: 'light', background: '#ffffff', foreground: '#111111' } as const;

function mount(api: Partial<ApiClient>, onLoadError = jest.fn()) {
  return render(
    <ReaderHost
      api={api as ApiClient}
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
}: { ebook?: jest.Mock; onMessage?: jest.Mock; onLoadError?: jest.Mock } = {}) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ReaderHost
        api={{ ebook } as unknown as ApiClient}
        libraryId={1}
        path="A/Book"
        name="Book"
        theme={theme}
        fontScale={1}
        title="Reader"
        onMessage={onMessage}
        onLoadError={onLoadError}
      />,
    );
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
  return { ebook, onMessage, onLoadError, say, types, unmount };
}

describe('ReaderHost (web) in a page', () => {
  it('opens the book once when it arrives before the reader is ready', async () => {
    const host = await mountInPage();
    await host.say({ type: 'ready' });
    expect(host.ebook).toHaveBeenCalledTimes(1);
    expect(host.types()).toEqual(['open']);
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
