import { act, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

// Capture the connection id ContentScope publishes as the scope, plus any redirect. A
// fake ConnectionScope records the prop and renders its children (a probe) so we assert
// the *resolved* scope without pulling in the real provider/query-client internals.
let scopedTo: string | undefined;
jest.mock('@/api/provider', () => ({
  ConnectionScope: ({
    connectionId,
    children,
  }: {
    connectionId: string;
    children: React.ReactNode;
  }) => {
    scopedTo = connectionId;
    return children;
  },
}));

// The route's own local param drives the scope; flip it per test. Redirect is a spy so we
// can assert the unknown-connection guard fires without a real router.
const mockRedirect = jest.fn((_props: { href: unknown }) => null);
let mockParams: Record<string, unknown> = {};
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  Redirect: (props: { href: unknown }) => mockRedirect(props),
}));

let mockConnections: { id: string }[] = [];
jest.mock('@/stores/session', () => ({
  useSession: (selector: (s: { connections: { id: string }[] }) => unknown) =>
    selector({ connections: mockConnections }),
}));

/* eslint-disable import/first */
import { ContentScope } from './content-scope';
/* eslint-enable import/first */

beforeEach(() => {
  scopedTo = undefined;
  mockParams = {};
  mockConnections = [];
  mockRedirect.mockClear();
});

const Probe = () => <Text>content</Text>;

// This jest-expo + React 19 setup renders concurrently, so mount inside an awaited act.
async function mount() {
  await act(async () => {
    render(
      <ContentScope>
        <Probe />
      </ContentScope>,
    );
  });
}

describe('ContentScope resolves the scope from the route local param (not the default)', () => {
  it('publishes the connection carried by the route, even when it is not the default', async () => {
    // The deep-link scenario: /book/5?connection=c2 with c2 signed in but NOT first.
    mockParams = { connection: 'c2' };
    mockConnections = [{ id: 'c1' }, { id: 'c2' }];

    await mount();

    expect(screen.getByText('content')).toBeTruthy();
    // Scoped to c2 - the route's own connection - not '' (which would fall back to the
    // default c1 and fetch the wrong server's data). This is the cold-deep-link fix.
    expect(scopedTo).toBe('c2');
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it('normalizes an array-form param (Expo Router can hand back string[])', async () => {
    mockParams = { connection: ['c2'] };
    mockConnections = [{ id: 'c2' }];

    await mount();

    expect(scopedTo).toBe('c2');
  });

  it('redirects home (no scope, no children) when the id is not a signed-in connection', async () => {
    mockParams = { connection: 'ghost' };
    mockConnections = [{ id: 'c1' }];

    await mount();

    expect(mockRedirect).toHaveBeenCalledWith({ href: '/' });
    // Guarded: the children never render, so a sub-component's useApi() can't throw.
    expect(screen.queryByText('content')).toBeNull();
    expect(scopedTo).toBeUndefined();
  });

  it("defaults to '' when the route carries no connection (aggregated screens)", async () => {
    mockParams = {};
    mockConnections = [{ id: 'c1' }];

    await mount();

    // Empty scope -> useCid() falls back to the default connection; never redirects.
    expect(scopedTo).toBe('');
    expect(mockRedirect).not.toHaveBeenCalled();
  });
});
