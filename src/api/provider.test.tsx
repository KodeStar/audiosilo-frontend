import { act, render } from '@testing-library/react-native';

import { useSession } from '@/stores/session';

import { type ApiConnection, ApiProvider, useApis } from './provider';

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
