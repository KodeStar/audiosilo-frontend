/**
 * @jest-environment jsdom
 */

import { render, waitFor } from '@testing-library/react-native';

import type { ApiClient } from '@/api/client';

import { READER_URL, ReaderHost } from './reader-host.web';

// The web host's own seams (jest runs the native platform, so the web file is imported
// directly): the sandboxed frame, the book fetched by the host, a failed fetch reported.

const theme = { scheme: 'light', background: '#ffffff', foreground: '#111111' } as const;

function mount(api: Partial<ApiClient>, onLoadError = jest.fn(), onMessage = jest.fn()) {
  return render(
    <ReaderHost
      api={api as ApiClient}
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

  it('ignores a message from any window but the reader frame', async () => {
    const onMessage = jest.fn();
    await mount({ ebook: jest.fn(() => new Promise<ArrayBuffer>(() => {})) }, jest.fn(), onMessage);
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'progress', cfi: 'epubcfi(/6/4!/4)', fraction: 0.5 },
        origin: window.location.origin,
      }),
    );
    expect(onMessage).not.toHaveBeenCalled();
  });
});
