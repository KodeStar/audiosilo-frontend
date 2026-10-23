import { fireEvent, screen } from '@testing-library/react-native';

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
jest.mock('@/api/provider', () => ({ useScopedCid: () => 'c1' }));
jest.mock('@/components/player/mini-player', () => ({ useMiniPlayerInset: () => 0 }));
const mockTitles: (string | undefined)[] = [];
jest.mock('@/lib/use-page-title', () => ({
  usePageTitle: (t: string | undefined) => mockTitles.push(t),
}));

let mockCaps: Record<string, boolean | undefined> = {};
jest.mock('@/api/hooks', () => ({
  useCapability: (flag: string) => mockCaps[flag],
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

const signIn = (user: object = {}) =>
  useSession.setState({
    connections: [{ id: 'c1', name: 'Home', serverUrl: 'u', token: 't', user } as never],
  });

beforeEach(() => {
  mockParams = { connection: 'c1', library: '7' };
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

  it('waits for the server before deciding', async () => {
    mockCaps = {};
    await mountWithPortal(<FindShowsScreen />);
    expect(screen.queryByTestId('section-search')).toBeNull();
    expect(screen.queryByText("Adding shows isn't available right now")).toBeNull();
  });

  it('says the link is broken without a library', async () => {
    mockParams = { connection: 'c1' };
    await mountWithPortal(<FindShowsScreen />);
    expect(screen.getByText("This link doesn't point to anything here.")).toBeTruthy();
  });
});
