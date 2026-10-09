import { renderHook } from '@testing-library/react-native';
import { Platform } from 'react-native';

const mockApi = {
  communityCoverUrl: (lib: number, path: string, url: string, o?: { size?: number }) =>
    `proxy:${lib}:${path}:${url}:${o?.size}`,
};
jest.mock('@/api/provider', () => ({ useOptionalApi: () => mockApi }));
let mockProxied: boolean | undefined;
const mockUseCapability = jest.fn((_flag: string, _cid?: string) => mockProxied);
jest.mock('@/api/hooks', () => ({
  useCapability: (flag: string, cid?: string) => mockUseCapability(flag, cid),
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
    mockProxied = true;
    const { result } = await renderHook(() => useCommunityCover('c1', 3, 'A/Book'));
    expect(mockUseCapability).toHaveBeenCalledWith('meta_covers', 'c1');
    expect(result.current(cover, 160)).toBe(`proxy:3:A/Book:${cover}:160`);
  });

  it('without the flag: the direct URL on native, the placeholder on web', async () => {
    mockProxied = false;
    Platform.OS = 'ios';
    const native = await renderHook(() => useCommunityCover('c1', 3, 'A/Book'));
    expect(native.result.current(cover, 320)).toBe(cover);
    Platform.OS = 'web';
    const web = await renderHook(() => useCommunityCover('c1', 3, 'A/Book'));
    expect(web.result.current(cover, 320)).toBeNull();
  });
});
