import { act, fireEvent, screen } from '@testing-library/react-native';

import { ApiError } from '@/api/client';
import { mountWithPortal } from '@/testing/render-overlay';

let mockParams: Record<string, string | undefined> = {};
const mockSetParams = jest.fn();
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  router: { setParams: (p: unknown) => mockSetParams(p) },
}));
jest.mock('@/components/layout/content-scope', () => ({
  ContentScope: ({ children }: { children: React.ReactNode }) => children,
}));
// The page's connection: the route's scope, else the default one (a link without it).
let mockCid = 'c1';
jest.mock('@/api/provider', () => ({ useCid: () => mockCid }));
jest.mock('@/components/player/mini-player', () => ({ useMiniPlayerInset: () => 0 }));
const mockTitles: (string | undefined)[] = [];
jest.mock('@/lib/use-page-title', () => ({
  usePageTitle: (t: string | undefined) => mockTitles.push(t),
}));

let mockOnline = true;
jest.mock('@/lib/device-online', () => ({
  ...jest.requireActual('@/lib/device-online'),
  useDeviceOnline: () => mockOnline,
}));

let mockCaps: Record<string, boolean | undefined> = {};
// The connections each capability was asked of.
const mockCapCids = new Set<string | undefined>();
// The connection's libraries; undefined while they load.
let mockLibraries: { id: number; kind?: string }[] | undefined;
let mockLibrariesFetching = false;
let mockLibrariesPaused = false;
let mockLibrariesError: Error | null = null;
// When the list was last read, and last failed (0: never), as TanStack stamps them.
let mockLibrariesReadAt = 1;
let mockLibrariesFailedAt = 0;
const mockLibrariesRead = jest.fn();
let mockServerPaused = false;
let mockServerError: Error | null = null;
let mockServerFetching = false;
let mockServerFailures = 0;
const mockServerRetry = jest.fn();
const mockLibrariesCids = new Set<string>();
jest.mock('@/api/hooks', () => ({
  useServerInfo: () => ({
    isPaused: mockServerPaused,
    error: mockServerError,
    isFetching: mockServerFetching,
    errorUpdateCount: mockServerFailures,
    refetch: mockServerRetry,
  }),
  useCapability: (flag: string, cid?: string) => {
    mockCapCids.add(cid);
    return mockCaps[flag];
  },
  useLibrariesOf: (cid: string) => {
    mockLibrariesCids.add(cid);
    return {
      data: mockLibraries,
      isFetching: mockLibrariesFetching,
      isPaused: mockLibrariesPaused,
      error: mockLibrariesError,
      dataUpdatedAt: mockLibrariesReadAt,
      errorUpdatedAt: mockLibrariesFailedAt,
      refetch: mockLibrariesRead,
    };
  },
}));

// Each section has its own suite: here, which one shows and with what.
jest.mock('./directory-search', () => ({
  DirectorySearch: ({
    header,
    footer,
    libraryId,
  }: {
    header: React.ReactNode;
    footer: React.ReactNode;
    libraryId: number;
  }) => {
    const { Text, View } = jest.requireActual('react-native');
    return (
      <View>
        {header}
        <Text testID="section-search">{`search ${libraryId}`}</Text>
        {footer}
      </View>
    );
  },
}));
jest.mock('./follow-by-url', () => ({
  FollowByUrl: ({ libraryId }: { libraryId: number }) => {
    const { Text } = jest.requireActual('react-native');
    return <Text testID="section-address">{`address ${libraryId}`}</Text>;
  },
}));
jest.mock('./follow-requests', () => ({
  FollowRequests: () => {
    const { Text } = jest.requireActual('react-native');
    return <Text testID="requests">requests</Text>;
  },
}));
jest.mock('./opml-import-panel', () => ({
  OpmlImportPanel: () => {
    const { Text } = jest.requireActual('react-native');
    return <Text testID="section-import">import</Text>;
  },
}));
const mockImportFor: [string, number][] = [];
jest.mock('./use-opml-import', () => ({
  useOpmlImport: (cid: string, lib: number) => {
    mockImportFor.push([cid, lib]);
    return {};
  },
}));

/* eslint-disable import/first */
import { useSession } from '@/stores/session';

import { FindShowsScreen } from './find-shows-screen';
/* eslint-enable import/first */

const signIn = (user: object = {}, id = 'c1') =>
  useSession.setState({
    connections: [{ id, name: 'Home', serverUrl: 'u', token: 't', user } as never],
  });

beforeEach(() => {
  mockOnline = true;
  mockParams = { connection: 'c1', library: '7' };
  mockCid = 'c1';
  mockCapCids.clear();
  mockLibraries = [{ id: 7, kind: 'podcasts' }];
  mockLibrariesFetching = false;
  mockLibrariesPaused = false;
  mockLibrariesError = null;
  mockLibrariesReadAt = 1;
  mockLibrariesFailedAt = 0;
  mockLibrariesRead.mockReset().mockResolvedValue(undefined);
  mockServerPaused = false;
  mockServerError = null;
  mockServerFetching = false;
  mockServerFailures = 0;
  mockServerRetry.mockReset().mockResolvedValue(undefined);
  mockLibrariesCids.clear();
  mockCaps = { podcasts: true, podcast_discovery: true, podcast_opml: true };
  mockSetParams.mockReset();
  mockTitles.length = 0;
  mockImportFor.length = 0;
  signIn();
});

describe('FindShowsScreen', () => {
  it('opens on the directory search with every section offered, and names the tab', async () => {
    await mountWithPortal(<FindShowsScreen />);
    expect(screen.getByText('Add shows')).toBeTruthy();
    expect(screen.getByTestId('section-search').props.children).toBe('search 7');
    expect(screen.getByTestId('requests')).toBeTruthy();
    expect(screen.getAllByRole('radio').map((r) => r.props.accessibilityLabel)).toEqual([
      'Search',
      'Feed address',
      'Import a list',
    ]);
    expect(mockTitles).toContain('Add shows');
    expect(mockImportFor.at(-1)).toEqual(['c1', 7]);
  });

  it('switches section through the route, so Back and a shared link keep it', async () => {
    await mountWithPortal(<FindShowsScreen />);
    await fireEvent.press(screen.getByRole('radio', { name: 'Import a list' }));
    expect(mockSetParams).toHaveBeenCalledWith({ section: 'import' });
  });

  it('shows the section the link names', async () => {
    mockParams = { ...mockParams, section: 'import' };
    await mountWithPortal(<FindShowsScreen />);
    expect(screen.getByTestId('section-import')).toBeTruthy();
    expect(screen.queryByTestId('section-search')).toBeNull();
  });

  it('offers only the feed address, with no picker, when the server has neither flag', async () => {
    mockCaps = { podcasts: true, podcast_discovery: false, podcast_opml: false };
    mockParams = { ...mockParams, section: 'search' };
    await mountWithPortal(<FindShowsScreen />);
    expect(screen.getByTestId('section-address').props.children).toBe('address 7');
    expect(screen.getByTestId('requests')).toBeTruthy();
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
  });

  it('drops the import section when OPML is off', async () => {
    mockCaps = { podcasts: true, podcast_discovery: true, podcast_opml: false };
    await mountWithPortal(<FindShowsScreen />);
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.queryByRole('radio', { name: 'Import a list' })).toBeNull();
  });

  it("tells a kid's account it can't add shows", async () => {
    signIn({ member_kind: 'kid' });
    await mountWithPortal(<FindShowsScreen />);
    expect(screen.getByText(/ask a grown-up/i)).toBeTruthy();
    expect(screen.queryByTestId('section-search')).toBeNull();
  });

  it('tells the demo it can’t add shows', async () => {
    signIn({ is_demo: true });
    await mountWithPortal(<FindShowsScreen />);
    expect(screen.getByText("The demo can't add shows.")).toBeTruthy();
    expect(screen.queryByTestId('section-search')).toBeNull();
  });

  it('says adding shows is unavailable when the module or its Bridge is off', async () => {
    mockCaps = { podcasts: false, podcast_discovery: true, podcast_opml: true };
    await mountWithPortal(<FindShowsScreen />);
    expect(screen.queryByTestId('section-search')).toBeNull();
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(screen.getByText("Adding shows isn't available right now")).toBeTruthy();
  });

  it('explains a held capability check before showing a loading state', async () => {
    mockCaps = {};
    mockServerPaused = true;
    await mountWithPortal(<FindShowsScreen />);
    expect(screen.getByText("You're offline")).toBeTruthy();
    expect(screen.queryByText('Retry')).toBeNull();
    expect(screen.queryByTestId('section-search')).toBeNull();
  });

  it('retries a failed capability check when online', async () => {
    mockCaps = {};
    mockServerError = new Error('unavailable');
    await mountWithPortal(<FindShowsScreen />);
    expect(screen.getByText("Couldn't check whether you can add shows.")).toBeTruthy();
    await fireEvent.press(screen.getByText('Retry'));
    expect(mockServerRetry).toHaveBeenCalled();
  });

  // TanStack puts a refetch with no data back to pending with no error, so the failure is
  // gone from the query while Retry's read runs.
  it('keeps the failed check with a busy Retry while Retry asks again', async () => {
    mockCaps = {};
    mockServerError = new ApiError(502, 'bad gateway');
    mockServerFailures = 1;
    let settle = () => {};
    mockServerRetry.mockImplementation(() => {
      mockServerError = null;
      mockServerFetching = true;
      return new Promise<void>((resolve) => (settle = resolve));
    });
    const view = await mountWithPortal(<FindShowsScreen />);
    await fireEvent.press(screen.getByText('Retry'));
    await view.rerender(<FindShowsScreen />);
    expect(screen.getByText("Couldn't check whether you can add shows.")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeBusy();
    // Failed again: the sentence with Retry ready.
    mockServerError = new ApiError(502, 'bad gateway');
    mockServerFailures = 2;
    mockServerFetching = false;
    await act(async () => settle());
    await view.rerender(<FindShowsScreen />);
    expect(screen.getByText("Couldn't check whether you can add shows.")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).not.toBeBusy();
  });

  // A refusal offers no Retry: its read again is a sign-in's or a focus's, never "failed".
  it('shows the loading state, not the failed check, while a refused check is read again', async () => {
    mockCaps = {};
    signIn();
    mockServerError = new ApiError(401, 'unauthorized');
    mockServerFailures = 1;
    const view = await mountWithPortal(<FindShowsScreen />);
    expect(screen.queryByText("Couldn't check whether you can add shows.")).toBeNull();
    mockServerError = null;
    mockServerFetching = true;
    await view.rerender(<FindShowsScreen />);
    expect(screen.queryByText("Couldn't check whether you can add shows.")).toBeNull();
    expect(screen.queryByText('Retry')).toBeNull();
  });

  it("offers no Retry for a server's failed answer while the device is offline", async () => {
    mockCaps = {};
    mockOnline = false;
    mockServerError = new ApiError(502, 'bad gateway');
    await mountWithPortal(<FindShowsScreen />);
    expect(screen.getByText("Couldn't check whether you can add shows.")).toBeTruthy();
    expect(screen.queryByText('Retry')).toBeNull();
  });

  it.each([
    ['held', { paused: true, online: true, failed: false }],
    ['failed with the device offline', { paused: false, online: false, failed: true }],
    ['failed online (the server may hold it since)', { paused: false, online: true, failed: true }],
  ])(
    'keeps the page while a kept list without the library is read again %s',
    async (_, { paused, online, failed }) => {
      mockLibraries = [{ id: 3 }];
      mockLibrariesPaused = paused;
      mockLibrariesError = failed ? new Error('unavailable') : null;
      mockOnline = online;
      await mountWithPortal(<FindShowsScreen />);
      expect(screen.getByTestId('section-search').props.children).toBe('search 7');
      expect(screen.queryByText("You're offline")).toBeNull();
      expect(screen.queryByTestId('find-shows-library-missing')).toBeNull();
    },
  );

  it('keeps the page while a libraries list not read yet waits for the network', async () => {
    mockLibraries = undefined;
    mockLibrariesPaused = true;
    await mountWithPortal(<FindShowsScreen />);
    expect(screen.getByTestId('section-search')).toBeTruthy();
    expect(screen.queryByText("You're offline")).toBeNull();
  });

  it('waits for the server before deciding', async () => {
    mockCaps = {};
    await mountWithPortal(<FindShowsScreen />);
    expect(screen.queryByTestId('section-search')).toBeNull();
    expect(screen.queryByText("Adding shows isn't available right now")).toBeNull();
  });

  it("is the default connection's from a link without ?connection= (fe#293)", async () => {
    mockParams = { library: '7' };
    mockCid = 'c2';
    signIn({}, 'c2');
    await mountWithPortal(<FindShowsScreen />);
    expect(screen.getByTestId('section-search').props.children).toBe('search 7');
    expect([...mockCapCids]).toEqual(['c2']);
  });

  it('refuses a library the default server does not have (no ?connection=)', async () => {
    mockParams = { library: '7' };
    mockCid = 'c2';
    signIn({}, 'c2');
    mockLibraries = [{ id: 3, kind: 'podcasts' }];
    const view = await mountWithPortal(<FindShowsScreen />);
    // Kept from before the page opened: read again before the library is called missing.
    expect(screen.queryByTestId('find-shows-library-missing')).toBeNull();
    expect(mockLibrariesRead).toHaveBeenCalledTimes(1);
    mockLibrariesReadAt = 2;
    await view.rerender(<FindShowsScreen />);
    expect(screen.getByTestId('find-shows-library-missing')).toBeTruthy();
    expect(screen.getByText("This link doesn't point to anything here.")).toBeTruthy();
    expect(screen.queryByTestId('section-search')).toBeNull();
    expect(screen.queryByTestId('section-address')).toBeNull();
    expect([...mockLibrariesCids]).toEqual(['c2']);
  });

  it('reads the list again when the page opens after its last read failed', async () => {
    mockLibrariesError = new ApiError(502, 'bad gateway');
    mockLibrariesFailedAt = 1;
    const view = await mountWithPortal(<FindShowsScreen />);
    expect(mockLibrariesRead).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('section-search')).toBeTruthy();
    // Failed again: not asked again on this library.
    mockLibrariesFailedAt = 2;
    await view.rerender(<FindShowsScreen />);
    expect(mockLibrariesRead).toHaveBeenCalledTimes(1);
  });

  it('opens on a library added since its kept list was read, online', async () => {
    mockLibraries = [{ id: 3, kind: 'podcasts' }];
    mockLibrariesRead.mockImplementation(async () => {
      mockLibraries = [{ id: 3 }, { id: 7 }];
      mockLibrariesReadAt = 2;
    });
    const view = await mountWithPortal(<FindShowsScreen />);
    await view.rerender(<FindShowsScreen />);
    expect(mockLibrariesRead).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('find-shows-library-missing')).toBeNull();
    expect(screen.getByTestId('section-search').props.children).toBe('search 7');
  });

  it('reads the list again once per library the page moves to', async () => {
    mockLibraries = [{ id: 7 }];
    const view = await mountWithPortal(<FindShowsScreen />);
    expect(mockLibrariesRead).not.toHaveBeenCalled();
    mockParams = { connection: 'c1', library: '8' };
    await view.rerender(<FindShowsScreen />);
    expect(mockLibrariesRead).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('find-shows-library-missing')).toBeNull();
    await view.rerender(<FindShowsScreen />);
    expect(mockLibrariesRead).toHaveBeenCalledTimes(1);
  });

  it('reads nothing for a listener who may not add shows', async () => {
    signIn({ member_kind: 'kid' });
    mockLibraries = [{ id: 3 }];
    await mountWithPortal(<FindShowsScreen />);
    expect(mockLibrariesRead).not.toHaveBeenCalled();
  });

  it('asks nothing while offline, nor again for a list read since the page opened', async () => {
    mockLibraries = [{ id: 3 }];
    mockOnline = false;
    const view = await mountWithPortal(<FindShowsScreen />);
    expect(mockLibrariesRead).not.toHaveBeenCalled();
    // The reconnect's own read answered without the library: missing, no second ask.
    mockOnline = true;
    mockLibrariesReadAt = 2;
    await view.rerender(<FindShowsScreen />);
    expect(mockLibrariesRead).not.toHaveBeenCalled();
    expect(screen.getByTestId('find-shows-library-missing')).toBeTruthy();
  });

  it('refuses nothing while a cached list without the library is read again', async () => {
    mockLibraries = [{ id: 3, kind: 'podcasts' }];
    mockLibrariesFetching = true;
    await mountWithPortal(<FindShowsScreen />);
    expect(screen.queryByTestId('find-shows-library-missing')).toBeNull();
  });

  it('shows the page while the libraries load', async () => {
    mockLibraries = undefined;
    await mountWithPortal(<FindShowsScreen />);
    expect(screen.queryByTestId('find-shows-library-missing')).toBeNull();
    expect(screen.getByTestId('section-search').props.children).toBe('search 7');
  });

  it('says the link is broken without a library', async () => {
    mockParams = { connection: 'c1' };
    await mountWithPortal(<FindShowsScreen />);
    expect(screen.getByText("This link doesn't point to anything here.")).toBeTruthy();
  });
});
