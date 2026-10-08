import { act, render } from '@testing-library/react-native';

import { useSession } from '@/stores/session';

import { setAddressPick, useAddressRoute } from './address-route';
import { type ApiConnection, ApiProvider, buildClients, useApis } from './provider';

jest.mock('./reachability', () => ({
  onReconnect: jest.fn(),
  setReachabilityClients: jest.fn(),
}));

const seen: ApiConnection[][] = [];

/** Hands every render's `useApis()` to `onApis`; `tick` only re-renders it. */
function Reader({ onApis }: { tick: number; onApis: (apis: ApiConnection[]) => void }) {
  onApis(useApis());
  return null;
}
const ui = (tick: number) => (
  <ApiProvider>
    <Reader tick={tick} onApis={(apis) => seen.push(apis)} />
  </ApiProvider>
);

describe('useApis', () => {
  // Callers memoise on it (the Journal's per-server queries, their merge): a new array on
  // every render would rebuild them all for nothing.
  it('is the same array across renders while the connections are, a new one when they change', async () => {
    useSession.setState({
      connections: [{ id: 'c1', name: 'Hearthside', serverUrl: 'https://h', token: 't' }],
    } as never);
    const view = await render(ui(0));
    await view.rerender(ui(1));
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.at(-1)).toBe(seen[0]);
    expect(seen[0].map((a) => a.connection.id)).toEqual(['c1']);

    await act(async () =>
      useSession.setState({
        connections: [
          { id: 'c1', name: 'Hearthside', serverUrl: 'https://h', token: 't' },
          { id: 'c2', name: 'Maya', serverUrl: 'https://m', token: 't' },
        ],
      } as never),
    );
    expect(seen.at(-1)).not.toBe(seen[0]);
    expect(seen.at(-1)!.map((a) => a.connection.id)).toEqual(['c1', 'c2']);
  });
});

describe('ApiProvider clients', () => {
  // A switch between a server's home and away address must reach every request the
  // provider's clients make (queries, mutations, media URLs).
  it('rebuilds a connection client on the address the player picked', async () => {
    const home = 'http://192.168.1.20:8080';
    useSession.setState({
      connections: [
        {
          id: 'c1',
          name: 'Hearthside',
          serverUrl: 'https://h',
          token: 't',
          addresses: { home, away: 'https://h' },
        },
      ],
    } as never);
    seen.length = 0;
    await render(ui(0));
    expect(seen.at(-1)![0].client.baseUrl).toBe('https://h');
    await act(async () => setAddressPick('c1', home));
    expect(seen.at(-1)![0].client.baseUrl).toBe(home);
    await act(async () => useAddressRoute.setState({ picks: {} }));
    expect(seen.at(-1)![0].client.baseUrl).toBe('https://h');
  });
});

describe('buildClients', () => {
  const home = 'http://192.168.1.20:8080';
  const conns = [
    { id: 'c1', serverUrl: 'https://h', token: 't', addresses: { home, away: 'https://h' } },
    { id: 'c2', serverUrl: 'https://m', token: 't' },
  ] as never[];

  it('rebuilds only the client whose address or token moved', () => {
    const first = buildClients(conns, {}, new Map());
    const switched = buildClients(conns, { c1: home }, first);
    expect(switched.get('c1')!.client).not.toBe(first.get('c1')!.client);
    expect(switched.get('c1')!.client.baseUrl).toBe(home);
    expect(switched.get('c2')!.client).toBe(first.get('c2')!.client);
    const repaired = buildClients(
      [conns[0], { ...(conns[1] as object), token: 'fresh' }] as never[],
      { c1: home },
      switched,
    );
    expect(repaired.get('c1')!.client).toBe(switched.get('c1')!.client);
    expect(repaired.get('c2')!.client).not.toBe(switched.get('c2')!.client);
  });

  it('drops a removed connection', () => {
    const first = buildClients(conns, {}, new Map());
    expect([...buildClients([conns[0]], {}, first).keys()]).toEqual(['c1']);
  });
});
