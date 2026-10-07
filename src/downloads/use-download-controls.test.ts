import { renderHook } from '@testing-library/react-native';
import { Platform } from 'react-native';

import type { Book } from '@/api/types';

let mockCanTranscode: boolean | undefined = true;
jest.mock('@/api/hooks', () => ({ useCapability: () => mockCanTranscode }));
jest.mock('@/api/provider', () => ({ useScopedCid: () => 'c1' }));
let mockEntry: { status: string } | undefined;
jest.mock('./store', () => ({
  useDownloadEntry: () => mockEntry,
  useDownloads: Object.assign(
    (select: (s: { supported: boolean }) => unknown) => select({ supported: true }),
    { getState: () => ({ download: jest.fn(), cancel: jest.fn() }) },
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
    mockEntry = undefined;
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
    mockEntry = { status: 'downloaded' };
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
