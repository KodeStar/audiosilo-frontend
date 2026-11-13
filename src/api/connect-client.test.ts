import { Platform } from 'react-native';

import { useSession } from '@/stores/session';

import { connectClient } from './connect-client';
import { probeServerId } from './server-id-probe';

// The connect flow's bare clients (fe#167): the proxy headers entered on the connect screen
// go to the address they were entered for, and to nothing else (an http fallback, a home
// address, another server a QR code names).

const SET = {
  origin: 'https://books.example.com',
  headers: [{ name: 'CF-Access-Client-Secret', value: 'proxy-secret' }],
};

function installFetch(): jest.Mock {
  const mock = jest.fn(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => JSON.stringify({ server_id: 'srv', name: 'Hearthside' }),
  }));
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

const sentSecret = (mock: jest.Mock, i = 0) =>
  (mock.mock.calls[i][1] as RequestInit & { headers: Record<string, string> }).headers[
    'CF-Access-Client-Secret'
  ];

describe('the connect flow carries proxy headers to their address only', () => {
  const realOS = Platform.OS;
  beforeEach(() => {
    (Platform as { OS: string }).OS = 'ios';
    useSession.setState({ connections: [], pendingProxyHeaders: SET });
  });
  afterEach(() => {
    (Platform as { OS: string }).OS = realOS;
    useSession.setState({ pendingProxyHeaders: null });
  });

  it('asks the address they were entered for with them', async () => {
    const fetchMock = installFetch();
    await connectClient('https://books.example.com').serverInfo();
    await connectClient('https://books.example.com/').exchange('pt', 'Phone');
    expect(sentSecret(fetchMock, 0)).toBe('proxy-secret');
    expect(sentSecret(fetchMock, 1)).toBe('proxy-secret');
  });

  it('asks the plain-http fallback, a home address or another server without them', async () => {
    const fetchMock = installFetch();
    await connectClient('http://books.example.com').serverInfo();
    await connectClient('http://192.168.1.5:8080').serverInfo();
    await connectClient('https://other.example.com').exchange('pt', 'Phone');
    for (let i = 0; i < 3; i++) expect(sentSecret(fetchMock, i)).toBeUndefined();
  });

  it('asks with none once the connect screen has dropped them', async () => {
    useSession.setState({ pendingProxyHeaders: null });
    const fetchMock = installFetch();
    await connectClient('https://books.example.com').serverInfo();
    expect(sentSecret(fetchMock)).toBeUndefined();
  });

  it('probes an address with them only when they are for that address', async () => {
    const fetchMock = installFetch();
    expect(await probeServerId('https://books.example.com')).toBe('srv');
    expect(await probeServerId('http://192.168.1.5:8080')).toBe('srv');
    expect(sentSecret(fetchMock, 0)).toBe('proxy-secret');
    expect(sentSecret(fetchMock, 1)).toBeUndefined();
  });

  it('never sends a set over plain http: the home-address probe asks with none', async () => {
    const HOME = 'http://192.168.1.5:8080';
    const homeSet = { ...SET, origin: HOME };
    // A set bound to the http home address, as if held (one is refused at entry and load).
    useSession.setState({
      pendingProxyHeaders: homeSet,
      connections: [
        { serverUrl: HOME, serverId: 'srv', token: 't', id: 'srv.1', proxyHeaders: homeSet },
      ] as never,
    });
    const fetchMock = installFetch();
    expect(await probeServerId(HOME)).toBe('srv');
    await connectClient(HOME).serverInfo();
    for (let i = 0; i < 2; i++) expect(sentSecret(fetchMock, i)).toBeUndefined();
  });

  it("signs a reconnect in with its own set only, never another person's", async () => {
    const mine = { origin: SET.origin, headers: [{ name: 'X-Mine', value: 'my-secret' }] };
    const base = { serverUrl: SET.origin, serverId: 'srv', token: 't' };
    useSession.setState({
      pendingProxyHeaders: null,
      connections: [
        { ...base, id: 'srv.1', user: { id: 1 }, proxyHeaders: SET },
        { ...base, id: 'srv.2', user: { id: 2 } },
        { ...base, id: 'srv.3', user: { id: 3 }, proxyHeaders: mine },
      ] as never,
    });
    const fetchMock = installFetch();
    // Denied: srv.2 has none of its own; srv.1's set for the same address stays with srv.1.
    await connectClient(SET.origin, undefined, 'srv.2').login('kid', 'pw', 'Phone');
    expect(sentSecret(fetchMock, 0)).toBeUndefined();
    // Allowed: srv.3's own.
    await connectClient(SET.origin, undefined, 'srv.3').login('kid', 'pw', 'Phone');
    const sent = (fetchMock.mock.calls[1][1] as { headers: Record<string, string> }).headers;
    expect(sent['X-Mine']).toBe('my-secret');
    expect(sent['CF-Access-Client-Secret']).toBeUndefined();
  });
});
