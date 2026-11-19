import { Platform } from 'react-native';

import { useSession } from '@/stores/session';

import { connectClient, connectClientFor, keptSetRefused } from './connect-client';
import { probeServerId } from './server-id-probe';

// The connect flow's bare clients (fe#167): the proxy headers entered on the connect screen,
// else the set kept for the address (fe#295), go with requests to the address they are for,
// and not to an http fallback, a home address or another server a QR code names.

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
    useSession.setState({ connections: [], pendingProxyHeaders: SET, proxySets: {} });
  });
  afterEach(() => {
    (Platform as { OS: string }).OS = realOS;
    useSession.setState({ pendingProxyHeaders: null, proxySets: {} });
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
    useSession.setState({ pendingProxyHeaders: homeSet, proxySets: { [HOME]: homeSet } });
    const fetchMock = installFetch();
    expect(await probeServerId(HOME)).toBe('srv');
    await connectClient(HOME).serverInfo();
    for (let i = 0; i < 2; i++) expect(sentSecret(fetchMock, i)).toBeUndefined();
  });

  // fe#295: one set per origin on the device, whoever's sign-in kept it.
  it("carries the set kept for the address when none was typed, and another address's never", async () => {
    const kept = { origin: SET.origin, headers: [{ name: 'X-Kept', value: 'kept-secret' }] };
    const HOME = 'https://nas.example.com';
    useSession.setState({ pendingProxyHeaders: null, proxySets: { [SET.origin]: kept } });
    const fetchMock = installFetch();
    const sent = (i: number) =>
      (fetchMock.mock.calls[i][1] as { headers: Record<string, string> }).headers;
    // Allowed: the address's own set, for a sign-in and a probe alike.
    await connectClient(SET.origin).login('kid', 'pw', 'Phone');
    expect(sent(0)['X-Kept']).toBe('kept-secret');
    expect(await probeServerId(SET.origin)).toBe('srv');
    expect(sent(1)['X-Kept']).toBe('kept-secret');
    // Denied: another https address (the server's home one) has none kept, so gets none.
    expect(await probeServerId(HOME)).toBe('srv');
    expect(sent(2)['X-Kept']).toBeUndefined();
    // A set typed for the address wins over the one kept (a rotated token).
    useSession.setState({ pendingProxyHeaders: SET });
    await connectClient(SET.origin).serverInfo();
    expect(sent(3)['X-Kept']).toBeUndefined();
    expect(sentSecret(fetchMock, 3)).toBe('proxy-secret');
  });

  it('names the set its requests carry, none where none goes (finishConnect keeps it)', () => {
    expect(connectClientFor('https://books.example.com/').proxy).toEqual(SET);
    expect(connectClientFor('https://other.example.com').proxy).toBeUndefined();
    expect(connectClientFor('http://books.example.com').proxy).toBeUndefined();
    useSession.setState({ pendingProxyHeaders: null });
    expect(connectClientFor('https://books.example.com').proxy).toBeUndefined();
  });

  // The probe of a kept set a kid's sign-in may not replace (`finishConnect`): one tokenless
  // `GET /server` to the set's origin carrying it, whatever the connect screen holds. Only the
  // proxy's own 401 or 403 says the set is stale.
  describe('keptSetRefused', () => {
    const KEPT = { origin: SET.origin, headers: [{ name: 'X-Kept', value: 'kept-secret' }] };
    const answer = (status: number, text: string) => {
      const mock = jest.fn(async () => ({
        ok: status >= 200 && status < 300,
        status,
        statusText: '',
        headers: { get: () => null },
        text: async () => text,
      }));
      globalThis.fetch = mock as unknown as typeof fetch;
      return mock;
    };

    it("asks the set's origin for /server with the kept set and no token", async () => {
      const fetchMock = installFetch();
      expect(await keptSetRefused(KEPT)).toBe(false);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [
        string,
        { headers: Record<string, string> },
      ];
      expect(url).toBe('https://books.example.com/api/v1/server');
      expect(init.headers['X-Kept']).toBe('kept-secret');
      // Never the set typed on the connect screen, nor a token.
      expect(init.headers['CF-Access-Client-Secret']).toBeUndefined();
      expect(init.headers.Authorization).toBeUndefined();
    });

    it("is refused only by the proxy's own 401 or 403", async () => {
      answer(403, '<html>Forbidden</html>');
      expect(await keptSetRefused(KEPT)).toBe(true);
      answer(401, '');
      expect(await keptSetRefused(KEPT)).toBe(true);
    });

    it("takes the server's own refusal, a gateway's answer and no answer as no sign of a stale set", async () => {
      answer(403, JSON.stringify({ error: 'forbidden' }));
      expect(await keptSetRefused(KEPT)).toBe(false);
      answer(502, '<html>Bad gateway</html>');
      expect(await keptSetRefused(KEPT)).toBe(false);
      globalThis.fetch = jest.fn(async () => {
        throw new TypeError('Network request failed');
      }) as unknown as typeof fetch;
      expect(await keptSetRefused(KEPT)).toBe(false);
    });
  });
});
