import { Platform } from 'react-native';

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

  // --- Enriched metadata (GET /libraries/{id}/meta) --------------------------

  it('fetches book metadata via GET /libraries/{id}/meta?path=, passing the token', async () => {
    const fetchMock = installFetch(() => ({ status: 200, body: { matched: false } }));
    await new ApiClient('https://h', 'tok').bookMeta(3, 'A/Book');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe('https://h/api/v1/libraries/3/meta?path=A%2FBook');
    expect(init.method).toBe('GET');
    expect(headerValue(init, 'Authorization')).toBe('Bearer tok');
  });

  it('passes through a matched metadata envelope unchanged', async () => {
    const envelope = {
      matched: true,
      work: {
        id: 'the-martian',
        title: 'The Martian',
        authors: [{ id: 'andy-weir', name: 'Andy Weir' }],
        language: 'en',
        description: 'Stranded on Mars.',
      },
      recording: { id: 'podium-2013', narrators: [{ id: 'r-c-bray', name: 'R. C. Bray' }] },
      web_url: 'https://meta.audiosilo.app/work?id=the-martian',
    };
    installFetch(() => ({ status: 200, body: envelope }));
    await expect(new ApiClient('https://h', 'tok').bookMeta(1, 'x')).resolves.toEqual(envelope);
  });

  it('passes through a matched:false result (no ids / no upstream match)', async () => {
    installFetch(() => ({ status: 200, body: { matched: false } }));
    await expect(new ApiClient('https://h', 'tok').bookMeta(1, 'x')).resolves.toEqual({
      matched: false,
    });
  });

  it('surfaces an ApiError when the meta service is unavailable (502)', async () => {
    installFetch(() => ({ status: 502, body: { error: 'metadata service unavailable' } }));
    await expect(new ApiClient('https://h', 'tok').bookMeta(1, 'x')).rejects.toMatchObject({
      name: 'ApiError',
      status: 502,
      message: 'metadata service unavailable',
    });
  });

  // --- One work by meta id (GET /meta/work) ----------------------------------

  it('fetches a work via GET /meta/work?id=, url-encoding the id', async () => {
    const fetchMock = installFetch(() => ({ status: 200, body: { work: { id: 'a/b' } } }));
    await new ApiClient('https://h', 'tok').metaWork('a/b');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe('https://h/api/v1/meta/work?id=a%2Fb');
    expect(init.method).toBe('GET');
    expect(headerValue(init, 'Authorization')).toBe('Bearer tok');
  });

  it('unwraps the { work } envelope', async () => {
    const work = {
      id: 'the-martian',
      title: 'The Martian',
      authors: [{ id: 'andy-weir', name: 'Andy Weir' }],
      language: 'en',
      recap_summary: { in_short: 'Stranded on Mars.', ending: 'He gets home.' },
    };
    installFetch(() => ({ status: 200, body: { work } }));
    await expect(new ApiClient('https://h', 'tok').metaWork('the-martian')).resolves.toEqual(work);
  });

  it('surfaces an ApiError for an unknown work id / a server without the route (404)', async () => {
    installFetch(() => ({ status: 404, body: { error: 'not found' } }));
    await expect(new ApiClient('https://h', 'tok').metaWork('nope')).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
      message: 'not found',
    });
  });

  // --- Player redesign 1a: meta bundle params ---------------------------------

  it('requests meta with include=previous and spoilers=hide only when asked', async () => {
    const fetchMock = installFetch(() => ({ status: 200, body: { matched: false } }));
    const c = new ApiClient('https://h', 'tok');
    await c.bookMeta(3, 'A/Book', undefined, { includePrevious: true, hideSpoilers: true });
    await c.bookMeta(3, 'A/Book', undefined, { includePrevious: true });
    await c.bookMeta(3, 'A/Book', undefined, { includePrevious: false, hideSpoilers: false });
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls).toEqual([
      'https://h/api/v1/libraries/3/meta?path=A%2FBook&include=previous&spoilers=hide',
      'https://h/api/v1/libraries/3/meta?path=A%2FBook&include=previous',
      // Explicitly-off options produce today's exact request.
      'https://h/api/v1/libraries/3/meta?path=A%2FBook',
    ]);
  });

  it('passes previous, attribution, community_description, chapter_count and local through', async () => {
    const attribution = {
      credit: 'AudioSilo Meta community contributors',
      license: 'CC BY-SA 4.0',
      license_url: 'https://creativecommons.org/licenses/by-sa/4.0/',
      source_url: 'https://meta.audiosilo.app/work?id=b2',
    };
    const envelope = {
      matched: true,
      work: {
        id: 'b2',
        title: 'Book Two',
        authors: [],
        language: 'en',
        community_description: { text: 'A sequel.', license: 'CC BY-SA 4.0' },
        attribution,
      },
      recording: { id: 'r2', narrators: [], chapter_count: 24 },
      series: [
        {
          id: 's',
          name: 'Saga',
          position: '2',
          works: [
            {
              id: 'b1',
              title: 'Book One',
              position: '1',
              authors: [],
              web_url: 'https://meta.audiosilo.app/work?id=b1',
              local: { library_id: 1, path: 'Saga/1' },
            },
          ],
        },
      ],
      previous: [{ id: 'b1', title: 'Book One', authors: [], language: 'en' }],
      web_url: 'https://meta.audiosilo.app/work?id=b2',
    };
    installFetch(() => ({ status: 200, body: envelope }));
    const meta = await new ApiClient('https://h', 'tok').bookMeta(1, 'Saga/2', undefined, {
      includePrevious: true,
    });
    expect(meta).toEqual(envelope);
    if (!meta.matched) throw new Error('expected a matched envelope');
    expect(meta.work.attribution).toEqual(attribution);
    expect(meta.recording?.chapter_count).toBe(24);
    expect(meta.series?.[0].works[0].local).toEqual({ library_id: 1, path: 'Saga/1' });
    expect(meta.previous?.[0].id).toBe('b1');
  });

  // --- Cover sizes -----------------------------------------------------------

  it('keeps the old coverUrl shape when no options are passed', () => {
    expect(new ApiClient('https://h', 'tok').coverUrl(3, 'A/Book')).toBe(
      'https://h/api/v1/libraries/3/cover?path=A%2FBook&token=tok',
    );
  });

  it('appends size and v to the cover URL, keeping the media token', () => {
    const c = new ApiClient('https://h', 'tok');
    expect(c.coverUrl(3, 'A/Book', { size: 320, version: 'ab12' })).toBe(
      'https://h/api/v1/libraries/3/cover?path=A%2FBook&size=320&v=ab12&token=tok',
    );
    expect(c.coverUrl(3, 'A/Book', { size: 160 })).toBe(
      'https://h/api/v1/libraries/3/cover?path=A%2FBook&size=160&token=tok',
    );
    // An empty cover_version is no version.
    expect(c.coverUrl(3, 'A/Book', { version: '' })).toBe(
      'https://h/api/v1/libraries/3/cover?path=A%2FBook&token=tok',
    );
  });

  // --- Browse lists & books filter -------------------------------------------

  it('lists books with filters, cursor and sort encoded, and returns the page', async () => {
    const fetchMock = installFetch(() => ({
      status: 200,
      body: { books: [{ id: 1, title: 'X' }], next_cursor: 'c2' },
    }));
    const page = await new ApiClient('https://h', 'tok').listBooks(2, {
      narrator: 'Kramer & Reading',
      sort: 'title',
      limit: 20,
      cursor: 'c1',
    });
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://h/api/v1/libraries/2/books?narrator=Kramer+%26+Reading&sort=title&limit=20&cursor=c1',
    );
    expect(page).toEqual({ books: [{ id: 1, title: 'X' }], next_cursor: 'c2' });
  });

  it('lists books with no filters and tolerates a null books array', async () => {
    const fetchMock = installFetch(() => ({ status: 200, body: { books: null } }));
    await expect(new ApiClient('https://h', 'tok').listBooks(2)).resolves.toEqual({ books: [] });
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://h/api/v1/libraries/2/books');
  });

  it('unwraps authors into people + unknown', async () => {
    const authors = [{ name: 'Andy Weir', books: 2, duration: 72000 }];
    const fetchMock = installFetch(() => ({ status: 200, body: { authors, unknown: 3 } }));
    await expect(new ApiClient('https://h', 'tok').authors(4)).resolves.toEqual({
      people: authors,
      unknown: 3,
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe('https://h/api/v1/libraries/4/authors');
    expect(init.method).toBe('GET');
    expect(headerValue(init, 'Authorization')).toBe('Bearer tok');
  });

  it('unwraps narrators into people + unknown, tolerating null and a missing count', async () => {
    const fetchMock = installFetch(() => ({ status: 200, body: { narrators: null } }));
    await expect(new ApiClient('https://h', 'tok').narrators(4)).resolves.toEqual({
      people: [],
      unknown: 0,
    });
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://h/api/v1/libraries/4/narrators');
  });

  it('unwraps the series list and tolerates a null array', async () => {
    const series = [{ name: 'Saga', author: 'A', books: 2, duration: 100, positions: [1, 3] }];
    const fetchMock = installFetch(() => ({ status: 200, body: { series } }));
    const c = new ApiClient('https://h', 'tok');
    await expect(c.seriesList(4)).resolves.toEqual(series);
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://h/api/v1/libraries/4/series');
    installFetch(() => ({ status: 200, body: { series: null } }));
    await expect(c.seriesList(4)).resolves.toEqual([]);
  });

  // --- Next book -------------------------------------------------------------

  it('fetches the next book via GET /libraries/{id}/next?path= and returns it as is', async () => {
    const body = {
      source: 'community',
      next: { library_id: 2, path: 'Saga/Book 3' },
      book: { id: 9, library_id: 2, rel_path: 'Saga/Book 3', title: 'Book 3' },
      work: {
        id: 'b3',
        title: 'Book 3',
        position: '3',
        authors: [],
        web_url: 'https://meta.audiosilo.app/work?id=b3',
        local: { library_id: 2, path: 'Saga/Book 3' },
      },
    };
    const fetchMock = installFetch(() => ({ status: 200, body }));
    await expect(new ApiClient('https://h', 'tok').nextBook(2, 'Saga/Book 2')).resolves.toEqual(
      body,
    );
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe('https://h/api/v1/libraries/2/next?path=Saga%2FBook+2');
    expect(init.method).toBe('GET');
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

  // --- onAuthError (dead-token detection choke point) -------------------------
  // Every request path funnels through request(); a 401 fires the injected callback so
  // whoever built the client can flag its connection for reconnect. 403 (scope denial),
  // 500, and a network failure/timeout must NOT fire it - they aren't dead tokens.

  it('fires onAuthError exactly once on a 401 response', async () => {
    installFetch(() => ({ status: 401, body: { error: 'invalid or expired token' } }));
    const onAuthError = jest.fn();
    const c = new ApiClient('https://h', 'tok', undefined, onAuthError);
    await expect(c.me()).rejects.toMatchObject({ name: 'ApiError', status: 401 });
    expect(onAuthError).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire onAuthError on a 403 scope/share denial', async () => {
    installFetch(() => ({ status: 403, body: { error: 'no access to this path' } }));
    const onAuthError = jest.fn();
    const c = new ApiClient('https://h', 'tok', undefined, onAuthError);
    await expect(c.me()).rejects.toMatchObject({ status: 403 });
    expect(onAuthError).not.toHaveBeenCalled();
  });

  it('does NOT fire onAuthError on a 500', async () => {
    installFetch(() => ({ status: 500, body: { error: 'boom' } }));
    const onAuthError = jest.fn();
    const c = new ApiClient('https://h', 'tok', undefined, onAuthError);
    await expect(c.me()).rejects.toMatchObject({ status: 500 });
    expect(onAuthError).not.toHaveBeenCalled();
  });

  it('does NOT fire onAuthError on a network failure / timeout (no HTTP status)', async () => {
    installHangingFetch();
    const onAuthError = jest.fn();
    const c = new ApiClient('https://h', 'tok', 10, onAuthError); // 10ms timeout
    await expect(c.serverInfo()).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(onAuthError).not.toHaveBeenCalled();
  });

  // --- Client identification header -------------------------------------------
  // Sent on native always; on web only same-origin (a cross-origin custom header would
  // force a CORS preflight that pre-header servers reject). Platform.OS and the page
  // origin are read in the constructor, so each case sets them before building.

  describe('X-AudioSilo-Client header', () => {
    const realOS = Platform.OS;
    const realLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');

    function setPlatform(os: string) {
      (Platform as { OS: string }).OS = os;
    }
    function setPageOrigin(origin: string | undefined) {
      Object.defineProperty(globalThis, 'location', {
        value: origin === undefined ? undefined : { origin },
        configurable: true,
        writable: true,
      });
    }

    afterEach(() => {
      setPlatform(realOS);
      if (realLocation) Object.defineProperty(globalThis, 'location', realLocation);
      else delete (globalThis as { location?: unknown }).location;
    });

    async function sentHeader(
      baseUrl: string,
      token: string | null = 'tok',
    ): Promise<string | undefined> {
      const fetchMock = installFetch(() => ({ status: 200, body: {} }));
      await new ApiClient(baseUrl, token).serverInfo();
      return headerValue(fetchMock.mock.calls[0][1] as RequestInit, 'X-AudioSilo-Client');
    }

    it('sends the client identity on native', async () => {
      setPlatform('ios');
      setPageOrigin(undefined);
      expect(await sentHeader('https://h')).toMatch(/^AudioSilo\/\S+ \(ios\)$/);
    });

    it('sends the client identity from a tokenless (onboarding) client', async () => {
      setPlatform('android');
      expect(await sentHeader('https://h', null)).toMatch(/^AudioSilo\/\S+ \(android\)$/);
    });

    it('sends the client identity on same-origin web', async () => {
      setPlatform('web');
      setPageOrigin('https://h.test');
      expect(await sentHeader('https://h.test')).toMatch(/^AudioSilo\/\S+ \(web\)$/);
    });

    it('omits the client identity on cross-origin web', async () => {
      setPlatform('web');
      setPageOrigin('http://localhost:8081');
      expect(await sentHeader('https://h.test')).toBeUndefined();
    });

    it('keeps the identity out of authHeaders (used by the media layers)', () => {
      setPlatform('ios');
      expect(new ApiClient('https://h', 'tok').authHeaders()).toEqual({
        Authorization: 'Bearer tok',
      });
    });
  });
});
