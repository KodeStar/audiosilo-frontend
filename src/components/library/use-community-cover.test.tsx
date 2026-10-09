import { renderHook } from '@testing-library/react-native';
import { Platform } from 'react-native';

const mockApi = {
  communityCoverUrl: (lib: number, path: string, url: string, o?: { size?: number }) =>
    `proxy:${lib}:${path}:${url}:${o?.size}`,
};
jest.mock('@/api/provider', () => ({ useOptionalApi: () => mockApi }));
let mockInfo: { data?: { capabilities: { meta_covers?: boolean } }; isError: boolean };
const mockUseServerInfo = jest.fn((_cid?: string) => mockInfo);
jest.mock('@/api/hooks', () => ({
  useServerInfo: (cid?: string) => mockUseServerInfo(cid),
}));

/* eslint-disable import/first */
import { useCommunityCover } from './use-community-cover';
/* eslint-enable import/first */

const cover = 'https://m.media-amazon.com/x.jpg';
const originalOS = Platform.OS;
afterEach(() => {
  Platform.OS = originalOS;
});

describe('useCommunityCover', () => {
  it("reads the connection's meta_covers flag and proxies through the book's envelope", async () => {
    mockInfo = { data: { capabilities: { meta_covers: true } }, isError: false };
    const { result } = await renderHook(() => useCommunityCover('c1', 3, 'A/Book'));
    expect(mockUseServerInfo).toHaveBeenCalledWith('c1');
    expect(result.current(cover, 160)).toBe(`proxy:3:A/Book:${cover}:160`);
  });

  it('without the flag: the direct URL on native, the placeholder on web', async () => {
    mockInfo = { data: { capabilities: {} }, isError: false };
    Platform.OS = 'ios';
    const native = await renderHook(() => useCommunityCover('c1', 3, 'A/Book'));
    expect(native.result.current(cover, 320)).toBe(cover);
    Platform.OS = 'web';
    const web = await renderHook(() => useCommunityCover('c1', 3, 'A/Book'));
    expect(web.result.current(cover, 320)).toBeNull();
  });

  it('nothing while /server is loading; an unreachable one is a server without the flag', async () => {
    Platform.OS = 'ios';
    mockInfo = { isError: false };
    const loading = await renderHook(() => useCommunityCover('c1', 3, 'A/Book'));
    expect(loading.result.current(cover, 320)).toBeNull();
    mockInfo = { isError: true };
    const down = await renderHook(() => useCommunityCover('c1', 3, 'A/Book'));
    expect(down.result.current(cover, 320)).toBe(cover);
  });
});
