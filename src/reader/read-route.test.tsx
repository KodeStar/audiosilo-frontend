import { render } from '@testing-library/react-native';

// The `/read` route alone: the params it reads, and the connection it hands the screen.
let mockParams: Record<string, string | undefined> = {};
jest.mock('expo-router', () => ({ useLocalSearchParams: () => mockParams }));
let mockGate: unknown = null;
jest.mock('@/components/layout/content-scope', () => ({
  useRouteConnection: (connection: string | undefined) => ({
    cid: connection ?? '',
    gate: mockGate,
  }),
}));
// The active connection, the player's own fallback (`useCid`).
jest.mock('@/api/provider', () => ({ useCid: (id?: string) => id ?? 'active' }));
const mockScreen = jest.fn((_props: Record<string, unknown>) => null);
jest.mock('@/reader/reader-screen', () => ({
  ReaderScreen: (props: Record<string, unknown>) => mockScreen(props),
}));

/* eslint-disable import/first */
import ReaderRoute from '@/app/read';
/* eslint-enable import/first */

describe('/read', () => {
  beforeEach(() => {
    mockScreen.mockClear();
    mockGate = null;
  });

  it("reads through the link's connection", async () => {
    mockParams = { connection: 'c2', libraryId: '1', path: 'A/Book' };
    await render(<ReaderRoute />);
    expect(mockScreen).toHaveBeenLastCalledWith({
      connectionId: 'c2',
      libraryId: 1,
      path: 'A/Book',
    });
  });

  it('falls back to the active connection for a link without one (CONNECT-05)', async () => {
    mockParams = { libraryId: '1', path: 'A/Book' };
    await render(<ReaderRoute />);
    expect(mockScreen).toHaveBeenLastCalledWith({
      connectionId: 'active',
      libraryId: 1,
      path: 'A/Book',
    });
  });

  it("shows the route-connection gate instead (an unknown connection, another person's)", async () => {
    mockParams = { connection: 'gone', libraryId: '1', path: 'A/Book' };
    const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
    mockGate = <Text>not signed in</Text>;
    const view = await render(<ReaderRoute />);
    expect(mockScreen).not.toHaveBeenCalled();
    expect(view.getByText('not signed in')).toBeTruthy();
  });
});
