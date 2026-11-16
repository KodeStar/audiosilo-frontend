import { renderHook } from '@testing-library/react-native';
import { Platform } from 'react-native';

import type { Book } from '@/api/types';

let mockCanTranscode: boolean | undefined = true;
jest.mock('@/api/hooks', () => ({ useCapability: () => mockCanTranscode }));
// `useCid`: the caller's id, else the page's connection (the route's, else the active one).
let mockPageCid = 'c1';
jest.mock('@/api/provider', () => ({ useCid: (id?: string) => id ?? mockPageCid }));
let mockStatus: string | undefined;
const mockDownload = jest.fn();
jest.mock('./store', () => ({
  useDownloadState: () => ({ status: mockStatus, failure: undefined }),
  useDownloads: Object.assign(
    (select: (s: { supported: boolean }) => unknown) => select({ supported: true }),
    { getState: () => ({ download: mockDownload, cancel: jest.fn() }) },
  ),
}));

/* eslint-disable import/first */
import { useDownloadControls } from './use-download-controls';
/* eslint-enable import/first */

const ac3 = { rel_path: 'A/B.m4b', direct_playable: false } as Book;

describe('useDownloadControls (web transcode)', () => {
  const prevOS = Platform.OS;
  beforeEach(() => {
    Platform.OS = 'web';
    mockCanTranscode = true;
    mockStatus = undefined;
  });
  afterEach(() => {
    Platform.OS = prevOS;
  });

  async function controls(book: Book | undefined = ac3) {
    const { result } = await renderHook(() => useDownloadControls(2, 'A/B.m4b', book));
    return result.current;
  }

  it('turns downloading off, with the reason, for a book web plays transcoded', async () => {
    expect(await controls()).toMatchObject({ supported: false, needsTranscode: true });
  });

  it('keeps an existing download manageable', async () => {
    mockStatus = 'downloaded';
    expect(await controls()).toMatchObject({ supported: true, needsTranscode: false });
  });

  it('is unchanged without a transcoder, off web, or for a playable book', async () => {
    mockCanTranscode = false;
    expect((await controls()).supported).toBe(true);
    mockCanTranscode = true;
    Platform.OS = 'ios';
    expect((await controls()).supported).toBe(true);
    Platform.OS = 'web';
    expect((await controls({ ...ac3, direct_playable: true })).supported).toBe(true);
  });
});

describe('useDownloadControls (its connection)', () => {
  afterEach(() => {
    mockPageCid = 'c1';
    mockDownload.mockClear();
  });

  it('downloads under the active connection on a page with no route connection (fe#296)', async () => {
    mockPageCid = 'c2';
    const book = { rel_path: 'A/B.m4b' } as Book;
    const { result } = await renderHook(() => useDownloadControls(2, 'A/B.m4b', book));
    expect(result.current.connectionId).toBe('c2');
    result.current.start();
    expect(mockDownload).toHaveBeenCalledWith('c2', 2, book, undefined);
  });

  it("keeps the caller's connection over the scope", async () => {
    const { result } = await renderHook(() =>
      useDownloadControls(2, 'A/B.m4b', undefined, undefined, 'c3'),
    );
    expect(result.current.connectionId).toBe('c3');
  });
});
