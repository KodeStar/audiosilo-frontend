import { ApiClient } from '@/api/client';

type FetchResult = { status: number; body?: unknown };

/** Install a fake global fetch driven by `impl`; returns the jest mock. */
function installFetch(impl: (url: string, init: RequestInit) => FetchResult): jest.Mock {
  const mock = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const { status, body } = impl(String(input), init ?? {});
    const text = body === undefined ? '' : JSON.stringify(body);
    const res = {
      ok: status >= 200 && status < 300,
      status,
      statusText: `status ${status}`,
      text: () => Promise.resolve(text),
    } as Response;
    return Promise.resolve(res);
  });
  globalThis.fetch = mock as unknown as typeof globalThis.fetch;
  return mock;
}

function headerValue(init: RequestInit, name: string): string | undefined {
  return (init.headers as Record<string, string> | undefined)?.[name];
}

describe('ApiClient', () => {
  it('trims trailing slashes from the base url', () => {
    const c = new ApiClient('https://h//');
    expect(c.baseUrl).toBe('https://h');
    expect(c.apiUrl('/server')).toBe('https://h/api/v1/server');
  });

  it('builds query strings, skipping null/undefined values', () => {
    const c = new ApiClient('https://h');
    expect(c.apiUrl('/x', { a: 1, b: undefined, c: null, d: 'y' })).toBe(
      'https://h/api/v1/x?a=1&d=y',
    );
  });

  it('omits Authorization when there is no token', () => {
    expect(new ApiClient('https://h').authHeaders()).toEqual({});
    expect(new ApiClient('https://h', 'tok').authHeaders()).toEqual({
      Authorization: 'Bearer tok',
    });
  });

  it('sends the bearer token and parses the JSON body', async () => {
    const fetchMock = installFetch(() => ({ status: 200, body: { name: 'AudioSilo' } }));
    const info = await new ApiClient('https://h', 'tok').serverInfo();
    expect(info).toMatchObject({ name: 'AudioSilo' });
    expect(headerValue(fetchMock.mock.calls[0][1] as RequestInit, 'Authorization')).toBe(
      'Bearer tok',
    );
  });

  it('throws ApiError carrying the server error message on non-2xx', async () => {
    installFetch(() => ({ status: 403, body: { error: 'forbidden' } }));
    await expect(new ApiClient('https://h', 'tok').me()).rejects.toMatchObject({
      name: 'ApiError',
      status: 403,
      message: 'forbidden',
    });
  });

  it('returns undefined for 204 responses', async () => {
    installFetch(() => ({ status: 204 }));
    await expect(new ApiClient('https://h', 'tok').logout()).resolves.toBeUndefined();
  });

  it('unwraps list responses and tolerates a null array', async () => {
    installFetch(() => ({ status: 200, body: { libraries: null } }));
    await expect(new ApiClient('https://h', 'tok').libraries()).resolves.toEqual([]);
  });

  it('embeds the token in media URLs only when present', () => {
    const withTok = new ApiClient('https://h', 'tok');
    expect(withTok.coverUrl(3, 'A/Book')).toContain('token=tok');
    expect(withTok.streamUrl(3, 'A/Book', true)).toMatch(/download=1/);
    expect(new ApiClient('https://h').coverUrl(3, 'A/Book')).not.toContain('token=');
  });

  it('sets a password via POST /auth/password with the documented body', async () => {
    const fetchMock = installFetch(() => ({ status: 204 }));
    await new ApiClient('https://h', 'tok').setPassword('longenough');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe('https://h/api/v1/auth/password');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ password: 'longenough' });
  });

  it('mints a recovery code and unwraps recovery_code; clears via DELETE', async () => {
    const fetchMock = installFetch((url) =>
      String(url).endsWith('/auth/recovery')
        ? { status: 201, body: { recovery_code: 'ABCD-EFGH' } }
        : { status: 204 },
    );
    const c = new ApiClient('https://h', 'tok');
    await expect(c.generateRecoveryCode()).resolves.toBe('ABCD-EFGH');
    await c.clearRecoveryCode();
    const [, genInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const [, delInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(genInit.method).toBe('POST');
    expect(delInit.method).toBe('DELETE');
  });

  it('posts the documented body shape for exchange', async () => {
    const fetchMock = installFetch(() => ({ status: 200, body: { token: 't', user: {} } }));
    await new ApiClient('https://h').exchange('pair-token', 'iPhone');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({
      pairing_token: 'pair-token',
      device_name: 'iPhone',
    });
    expect(headerValue(init, 'Content-Type')).toBe('application/json');
  });

  it('lists favourites by GET /me/favourites and tolerates a null array', async () => {
    const fetchMock = installFetch(() => ({ status: 200, body: { favourites: null } }));
    await expect(new ApiClient('https://h', 'tok').favourites()).resolves.toEqual([]);
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://h/api/v1/me/favourites');
  });

  it('treats a 404 on favourites as an empty list (older server)', async () => {
    installFetch(() => ({ status: 404, body: { error: 'not found' } }));
    await expect(new ApiClient('https://h', 'tok').favourites()).resolves.toEqual([]);
  });

  it('adds and removes a favourite by path with the right method', async () => {
    const fetchMock = installFetch(() => ({ status: 204 }));
    const c = new ApiClient('https://h', 'tok');
    await c.addFavourite(3, 'Author/Series');
    await c.removeFavourite(3, 'Author/Series');
    const [addUrl, addInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const [delUrl, delInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(String(addUrl)).toBe('https://h/api/v1/libraries/3/favourites?path=Author%2FSeries');
    expect(addInit.method).toBe('POST');
    expect(String(delUrl)).toBe('https://h/api/v1/libraries/3/favourites?path=Author%2FSeries');
    expect(delInit.method).toBe('DELETE');
  });

  // A fetch that never resolves until its signal aborts.
  function installHangingFetch() {
    globalThis.fetch = jest.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }),
    ) as unknown as typeof globalThis.fetch;
  }

  it('surfaces a timeout as TimeoutError, not AbortError (review finding F3)', async () => {
    installHangingFetch();
    const c = new ApiClient('https://h', 'tok', 10); // 10ms timeout
    // A TimeoutError (not the AbortError a caller cancel raises) lets reachability
    // classify a frozen server as unreachable instead of ignoring it as a cancel.
    await expect(c.serverInfo()).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('propagates a caller-cancel as AbortError, not a timeout', async () => {
    installHangingFetch();
    const caller = new AbortController();
    const pending = new ApiClient('https://h', 'tok').serverInfo(caller.signal);
    caller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
