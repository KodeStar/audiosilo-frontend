import { Platform } from 'react-native';

import { probeServerId } from '@/api/server-id-probe';
import { useSession } from '@/stores/session';

import { connectClient } from './connect-client';

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
});
