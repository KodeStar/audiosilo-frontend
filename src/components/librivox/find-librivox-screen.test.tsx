import { screen } from '@testing-library/react-native';

import type { ServerInfo } from '@/api/types';
import { ADMIN } from '@/testing/bridge-fixtures';
import { librivoxServer } from '@/testing/librivox-fixtures';
import { mountWithPortal } from '@/testing/render-overlay';

let mockParams: Record<string, string | undefined> = {};
jest.mock('@/lib/route-params', () => ({ useRouteParams: () => mockParams }));
jest.mock('@/components/layout/content-scope', () => ({
  ContentScope: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@/api/provider', () => ({ useScopedCid: () => 'c1' }));
const mockTitles: (string | undefined)[] = [];
jest.mock('@/lib/use-page-title', () => ({
  usePageTitle: (t: string | undefined) => mockTitles.push(t),
}));
let mockServer: ServerInfo | undefined;
jest.mock('@/api/hooks', () => ({
  useServerInfo: () => ({ data: mockServer }),
}));
// The search has its own suite: here, whether the page shows it and for which library.
jest.mock('./librivox-search', () => ({
  LibrivoxSearch: ({
    header,
    libraryId,
    connectionId,
  }: {
    header: React.ReactNode;
    libraryId: number;
    connectionId: string;
  }) => {
    const { Text, View } = jest.requireActual('react-native');
    return (
      <View>
        {header}
        <Text testID="librivox-search">{`${connectionId} ${libraryId}`}</Text>
      </View>
    );
  },
}));

/* eslint-disable import/first */
import { useSession } from '@/stores/session';

import { FindLibrivoxScreen } from './find-librivox-screen';
/* eslint-enable import/first */

const signIn = (user: object = ADMIN) =>
  useSession.setState({
    connections: [{ id: 'c1', name: 'Home', serverUrl: 'u', token: 't', user } as never],
  });

beforeEach(() => {
  mockParams = { connection: 'c1', library: '3' };
  mockServer = librivoxServer();
  mockTitles.length = 0;
  signIn();
});

describe('FindLibrivoxScreen', () => {
  it('shows the search for an admin whose Bridge runs librivox, and names the tab', async () => {
    await mountWithPortal(<FindLibrivoxScreen />);
    expect(screen.getByText('Find on LibriVox')).toBeTruthy();
    expect(screen.getByTestId('librivox-search').props.children).toBe('c1 3');
    expect(mockTitles).toContain('Find on LibriVox');
  });

  it('waits for the server answer before deciding', async () => {
    mockServer = undefined;
    await mountWithPortal(<FindLibrivoxScreen />);
    expect(screen.getByTestId('find-librivox-loading')).toBeTruthy();
    expect(screen.queryByTestId('librivox-search')).toBeNull();
  });

  it('tells anyone but an admin that only an admin can add, and asks nothing', async () => {
    signIn({ ...ADMIN, role: 'user' });
    await mountWithPortal(<FindLibrivoxScreen />);
    expect(screen.getByText('Only an admin can add books from LibriVox.')).toBeTruthy();
    expect(screen.queryByTestId('librivox-search')).toBeNull();
  });

  it('tells a demo account the same', async () => {
    signIn({ ...ADMIN, is_demo: true });
    await mountWithPortal(<FindLibrivoxScreen />);
    expect(screen.getByText('Only an admin can add books from LibriVox.')).toBeTruthy();
  });

  it('says the Bridge must be online and up to date on an older server or Bridge', async () => {
    mockServer = librivoxServer({ bridge: { version: '0.6.0', features: ['sidecars'] } });
    await mountWithPortal(<FindLibrivoxScreen />);
    expect(
      screen.getByText('Adding from LibriVox needs your Bridge online and up to date.'),
    ).toBeTruthy();
    expect(screen.queryByTestId('librivox-search')).toBeNull();
  });

  it('says community metadata is off', async () => {
    const caps = librivoxServer().capabilities;
    mockServer = librivoxServer({ capabilities: { ...caps, metadata: false } });
    await mountWithPortal(<FindLibrivoxScreen />);
    expect(screen.getByText('Community metadata is off')).toBeTruthy();
    expect(screen.queryByTestId('librivox-search')).toBeNull();
  });

  it('says a link without a library points to nothing', async () => {
    mockParams = { connection: 'c1' };
    await mountWithPortal(<FindLibrivoxScreen />);
    expect(screen.getByText("This link doesn't point to anything here.")).toBeTruthy();
  });
});
