import { renderHook } from '@testing-library/react-native';

import type { Book } from '@/api/types';

// The book, the server's flags and the person (their hooks' own tests).
let mockBook: Partial<Book> | undefined;
let mockEbooks: boolean | undefined;
let mockServer: object | undefined;
jest.mock('@/api/hooks', () => ({
  useBook: () => ({ data: mockBook }),
  useCapability: () => mockEbooks,
  useServerInfo: () => ({ data: mockServer }),
}));
let mockUser: object | undefined;
jest.mock('@/stores/session', () => ({
  useSession: (select: (s: unknown) => unknown) =>
    select({ connections: [{ id: 'c1', user: mockUser }] }),
}));
let mockSavedEbook: string | undefined;
jest.mock('@/downloads/store', () => ({ useDownloadedEbook: () => mockSavedEbook }));
// The map (`useBookReadalong`'s own tests decide where it comes from).
let mockMap: { map: object | null; pending: boolean; failed?: boolean; retry?: () => void } = {
  map: null,
  pending: false,
};
const mockReadable = jest.fn();
jest.mock('@/reader/use-book-readalong', () => ({
  useBookReadalong: (_ref: unknown, _book: unknown, readable: boolean) => {
    mockReadable(readable);
    return mockMap;
  },
}));

/* eslint-disable import/first */
import { useTextTab } from './use-text-tab';
/* eslint-enable import/first */

const TARGET = { connectionId: 'c1', libraryId: 1, path: 'A/Book' };
const MAP = { sections: [{ href: 'c1.xhtml', spans: [] }] };
const EBOOK = { path: 'A/Book/a.epub', size: 3 };
const LISTENER = { role: 'user' };
const ADMIN = { role: 'admin' };
const BRIDGE_SERVER = {
  capabilities: { bridge: true, readalong: true },
  bridge: { version: '0.5.0', features: ['readalong'] },
};

const tab = async () => (await renderHook(() => useTextTab(TARGET))).result.current;

describe('useTextTab', () => {
  beforeEach(() => {
    mockBook = { ebook: EBOOK, readalong: { state: 'ready', generated_at: 'g1' } };
    mockEbooks = true;
    mockServer = BRIDGE_SERVER;
    mockUser = LISTENER;
    mockSavedEbook = undefined;
    mockMap = { map: MAP, pending: false };
    mockReadable.mockClear();
  });

  it('is there for a listener once the map is in', async () => {
    expect(await tab()).toMatchObject({ shown: true, map: MAP });
  });

  it('is absent for a listener while the map is on its way, or with none', async () => {
    mockMap = { map: null, pending: true };
    expect((await tab()).shown).toBe(false);
    mockBook = { ebook: EBOOK };
    mockMap = { map: null, pending: false };
    expect((await tab()).shown).toBe(false);
  });

  it("keeps an admin's tab while the map is on its way (a job that just made it)", async () => {
    mockUser = ADMIN;
    mockMap = { map: null, pending: true };
    expect(await tab()).toMatchObject({ shown: true, map: null, pending: true });
  });

  it("keeps a listener's tab when the map failed to load, with its retry", async () => {
    const retry = jest.fn();
    mockMap = { map: null, pending: false, failed: true, retry };
    expect(await tab()).toMatchObject({ shown: true, map: null, failed: true, retry });
  });

  it('is absent for a listener when the map is stale, and offers an admin Make', async () => {
    mockBook = { ebook: EBOOK, readalong: { state: 'stale', reason: 'audio_changed' } };
    mockMap = { map: null, pending: false };
    expect((await tab()).shown).toBe(false);
    mockUser = ADMIN;
    expect(await tab()).toMatchObject({ shown: true, map: null });
  });

  it('offers no Make where the Bridge cannot make maps, nor for a book without an ebook', async () => {
    mockUser = ADMIN;
    mockMap = { map: null, pending: false };
    mockServer = { capabilities: { bridge: true, readalong: true }, bridge: { features: [] } };
    expect((await tab()).shown).toBe(false);
    mockServer = BRIDGE_SERVER;
    mockBook = { readalong: undefined };
    expect((await tab()).shown).toBe(false);
  });

  it('reads offline from a download holding the EPUB, the capability unknown', async () => {
    mockEbooks = undefined;
    mockSavedEbook = 'file:///d/book.epub';
    expect((await tab()).shown).toBe(true);
    expect(mockReadable).toHaveBeenLastCalledWith(true);
    // Without the EPUB on the device, nothing reads offline.
    mockSavedEbook = undefined;
    await tab();
    expect(mockReadable).toHaveBeenLastCalledWith(false);
  });
});
