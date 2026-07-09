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

  it('requests a transcoded stream with a mid-file offset only when asked', () => {
    const c = new ApiClient('https://h', 'tok');
    // No opts → neither transcode nor t in the URL.
    const plain = c.streamUrl(3, 'A/Book');
    expect(plain).not.toMatch(/transcode=/);
    expect(plain).not.toMatch(/[?&]t=/);
    // transcode + a positive offset are both encoded.
    const tc = c.streamUrl(3, 'A/Book', false, { transcode: true, t: 42 });
    expect(tc).toMatch(/transcode=1/);
    expect(tc).toMatch(/[?&]t=42/);
    // t=0 (start of file) is omitted - same as no offset, so a seek re-request is unambiguous.
    expect(c.streamUrl(3, 'A/Book', false, { transcode: true, t: 0 })).not.toMatch(/[?&]t=/);
  });

  it('sets a password via POST /auth/password with the documented body', async () => {
    const fetchMock = installFetch(() => ({ status: 204 }));
    await new ApiClient('https://h', 'tok').setPassword('longenough');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe('https://h/api/v1/auth/password');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ password: 'longenough' });
  });

  it('includes current_password when changing an existing password', async () => {
    const fetchMock = installFetch(() => ({ status: 204 }));
    await new ApiClient('https://h', 'tok').setPassword('newpass12', 'oldpass12');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      password: 'newpass12',
      current_password: 'oldpass12',
    });
  });

  it('mints a recovery code via POST /auth/recovery and unwraps recovery_code', async () => {
    const fetchMock = installFetch(() => ({ status: 201, body: { recovery_code: 'ABCD-EFGH' } }));
    const c = new ApiClient('https://h', 'tok');
    await expect(c.generateRecoveryCode()).resolves.toBe('ABCD-EFGH');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe('https://h/api/v1/auth/recovery');
    expect(init.method).toBe('POST');
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

  it('creates an API key via POST /auth/tokens and returns the one-time secret + metadata', async () => {
    const fetchMock = installFetch(() => ({
      status: 200,
      body: {
        token: 'sk_live_secret',
        api_key: { id: 7, label: 'Dashboard', created_at: '2026-07-09T10:00:00Z', last_seen: null },
      },
    }));
    const res = await new ApiClient('https://h', 'tok').createApiKey('Dashboard');
    expect(res.token).toBe('sk_live_secret');
    expect(res.api_key).toMatchObject({ id: 7, label: 'Dashboard', last_seen: null });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe('https://h/api/v1/auth/tokens');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ label: 'Dashboard' });
    expect(headerValue(init, 'Authorization')).toBe('Bearer tok');
  });

  it('lists API keys via GET /auth/tokens, unwrapping api_keys and tolerating null', async () => {
    const keys = [{ id: 1, label: 'a', created_at: '2026-07-09T10:00:00Z', last_seen: null }];
    const withKeys = installFetch(() => ({ status: 200, body: { api_keys: keys } }));
    await expect(new ApiClient('https://h', 'tok').listApiKeys()).resolves.toEqual(keys);
    expect(String(withKeys.mock.calls[0][0])).toBe('https://h/api/v1/auth/tokens');

    installFetch(() => ({ status: 200, body: { api_keys: null } }));
    await expect(new ApiClient('https://h', 'tok').listApiKeys()).resolves.toEqual([]);
  });

  it('revokes an API key via DELETE /auth/tokens/{id}, succeeding on an empty 204', async () => {
    const fetchMock = installFetch(() => ({ status: 204 }));
    await expect(new ApiClient('https://h', 'tok').revokeApiKey(7)).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe('https://h/api/v1/auth/tokens/7');
    expect(init.method).toBe('DELETE');
  });

  it('revokes an API key successfully on an empty 200 body (no JSON to parse)', async () => {
    installFetch(() => ({ status: 200 }));
    await expect(new ApiClient('https://h', 'tok').revokeApiKey(9)).resolves.toBeUndefined();
  });

  it('surfaces the error envelope when creating an API key is refused', async () => {
    installFetch(() => ({ status: 403, body: { error: 'demo accounts cannot mint keys' } }));
    await expect(new ApiClient('https://h', 'tok').createApiKey('x')).rejects.toMatchObject({
      name: 'ApiError',
      status: 403,
      message: 'demo accounts cannot mint keys',
    });
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
