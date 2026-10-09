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

  // --- The player Book's new fields ------------------------------------------

  it('mirrors published, description, cover_color and cover_version on a Book', async () => {
    const body = {
      id: 9,
      library_id: 2,
      rel_path: 'Saga/Book 3',
      is_folder: false,
      title: 'Book 3',
      author: 'A',
      series: 'Saga',
      series_index: 3,
      narrator: 'N',
      duration: 3600,
      format: 'm4b',
      size: 1,
      published: '2014-02',
      description: 'A long blurb.',
      cover_color: { bg: '#102030', accent: '#ff6699', on_accent: '#000000' },
      cover_version: 'ab12cd34ef',
    };
    installFetch(() => ({ status: 200, body }));
    const book = await new ApiClient('https://h', 'tok').item(2, 'Saga/Book 3');
    // Typed reads, so a misnamed mirror field fails the type check, not only a match.
    expect(book.published).toBe('2014-02');
    expect(book.description).toBe('A long blurb.');
    expect(book.cover_color?.bg).toBe('#102030');
    expect(book.cover_color?.accent).toBe('#ff6699');
    expect(book.cover_color?.on_accent).toBe('#000000');
    expect(book.cover_version).toBe('ab12cd34ef');
  });

  // --- Community chapters (chapters_source) ----------------------------------

  const chaptersBody = {
    library_id: 2,
    path: 'Myths/Mythos',
    duration: 3600,
    is_folder: false,
    files: [
      { rel_path: 'Myths/Mythos/Mythos.m4b', seq: 0, duration: 3600, format: 'm4b', size: 1 },
    ],
    chapters: [
      {
        index: 0,
        title: 'Chaos',
        file_index: 0,
        file_path: 'Myths/Mythos/Mythos.m4b',
        start: 0,
        end: 1800,
        book_offset: 0,
      },
    ],
  };

  it('passes chapters_source through on the chapters and item envelopes', async () => {
    const fetchMock = installFetch((url) => ({
      status: 200,
      body: url.includes('/chapters')
        ? { ...chaptersBody, chapters_source: 'community' }
        : { id: 9, rel_path: 'Myths/Mythos', chapters_source: 'community' },
    }));
    const c = new ApiClient('https://h', 'tok');
    const data = await c.chapters(2, 'Myths/Mythos');
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      '/libraries/2/chapters?path=Myths%2FMythos',
    );
    // Typed reads, so a misnamed mirror field fails the type check, not only a match.
    expect(data.chapters_source).toBe('community');
    expect(data.chapters[0].title).toBe('Chaos');
    const book = await c.item(2, 'Myths/Mythos');
    expect(book.chapters_source).toBe('community');
  });

  it('leaves chapters_source undefined when the server sends none (files or older server)', async () => {
    installFetch(() => ({ status: 200, body: chaptersBody }));
    const data = await new ApiClient('https://h', 'tok').chapters(2, 'Myths/Mythos');
    expect(data.chapters_source).toBeUndefined();
    expect(data.chapters).toHaveLength(1);
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

  it('asks for every series a book is in only with memberships', async () => {
    const fetchMock = installFetch(() => ({ status: 200, body: { books: [], series: [] } }));
    const c = new ApiClient('https://h', 'tok');
    await c.listBooks(2, { series: 'City Watch', memberships: true });
    await c.listBooks(2, { series: 'City Watch', memberships: false });
    await c.seriesList(2, { memberships: true });
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      'https://h/api/v1/libraries/2/books?series=City+Watch&memberships=1',
      'https://h/api/v1/libraries/2/books?series=City+Watch',
      'https://h/api/v1/libraries/2/series?memberships=1',
    ]);
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

  // The server may spend its whole 15 s community-metadata budget on /next before it
  // answers from the local series or folder, and on /meta before it fetches the previous
  // works, so those two wait out the server's own 30 s request budget instead.
  it('gives the requests that wait on community metadata the server budget', async () => {
    jest.useFakeTimers();
    try {
      installHangingFetch();
      const c = new ApiClient('https://h', 'tok'); // the default 15 s
      const outcomes: Record<string, unknown> = {};
      const settle = (name: string, p: Promise<unknown>) =>
        p.catch((e: unknown) => {
          outcomes[name] = e;
        });
      const pending = [
        settle('next', c.nextBook(2, 'Saga/Book 2')),
        settle('previous', c.bookMeta(2, 'Saga/Book 2', undefined, { includePrevious: true })),
        settle('plain', c.bookMeta(2, 'Saga/Book 2')),
      ];
      await jest.advanceTimersByTimeAsync(15_000);
      expect(Object.keys(outcomes)).toEqual(['plain']);
      await jest.advanceTimersByTimeAsync(15_000);
      await Promise.all(pending);
      expect(outcomes.next).toMatchObject({ name: 'TimeoutError', timeoutMs: 30_000 });
      expect(outcomes.previous).toMatchObject({ name: 'TimeoutError', timeoutMs: 30_000 });
      expect(outcomes.plain).toMatchObject({ name: 'TimeoutError', timeoutMs: 15_000 });
    } finally {
      jest.useRealTimers();
    }
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

// --- User state & personal stats (Phase 1b) ----------------------------------

/** The URL, method and parsed JSON body of the `i`th request a fetch mock saw. */
function sent(fetchMock: jest.Mock, i = 0) {
  const [url, init] = fetchMock.mock.calls[i] as [string, RequestInit];
  return {
    url: String(url),
    method: init.method,
    body: init.body === undefined ? undefined : JSON.parse(init.body as string),
    contentType: headerValue(init, 'Content-Type'),
  };
}

const book = { id: 9, library_id: 2, rel_path: 'Saga/Book 1', title: 'Book 1' };
const entry = { library_id: 2, path: 'Saga/Book 1', added_at: '2026-10-01T10:00:00Z', book };
const collectionWire = {
  id: 5,
  name: 'Road trip',
  description: '',
  owner: { id: 1, username: 'ann' },
  owned: true,
  shared_with: [{ id: 2, username: 'bob' }],
  item_count: 1,
  preview: [book],
  created_at: '2026-10-01T10:00:00Z',
  updated_at: '2026-10-02T10:00:00Z',
};
const ratingWire = {
  library_id: 2,
  path: 'Saga/Book 1',
  rating: 4,
  note: 'Great',
  created_at: '2026-10-01T10:00:00Z',
  updated_at: '2026-10-02T10:00:00Z',
};

describe('ApiClient.history', () => {
  it('asks for the server default, or up to a limit when given', async () => {
    const fetchMock = installFetch(() => ({ status: 200, body: { history: null } }));
    const c = new ApiClient('https://h', 'tok');
    await expect(c.history(2, 'Saga/Book 1')).resolves.toEqual([]);
    await c.history(2, 'Saga/Book 1', 500);
    expect(sent(fetchMock, 0).url).toBe('https://h/api/v1/libraries/2/history?path=Saga%2FBook+1');
    expect(sent(fetchMock, 1).url).toBe(
      'https://h/api/v1/libraries/2/history?path=Saga%2FBook+1&limit=500',
    );
  });
});

describe('ApiClient user state (Phase 1b)', () => {
  const c = () => new ApiClient('https://h', 'tok');

  describe('Up next', () => {
    it('reads GET /me/queue, unwrapping { queue }', async () => {
      const fetchMock = installFetch(() => ({ status: 200, body: { queue: [entry] } }));
      await expect(c().queue()).resolves.toEqual([entry]);
      expect(sent(fetchMock)).toMatchObject({ url: 'https://h/api/v1/me/queue', method: 'GET' });
    });

    it('replaces the queue with PUT /me/queue { items } and returns the stored queue', async () => {
      const fetchMock = installFetch(() => ({ status: 200, body: { queue: [entry] } }));
      const items = [
        { library_id: 2, path: 'Saga/Book 1' },
        { library_id: 3, path: 'Other' },
      ];
      await expect(c().setQueue(items)).resolves.toEqual([entry]);
      expect(sent(fetchMock)).toEqual({
        url: 'https://h/api/v1/me/queue',
        method: 'PUT',
        body: { items },
        contentType: 'application/json',
      });
    });

    it('sends only {library_id, path} when replaying cached entries as the new order', async () => {
      // The server decodes list bodies strictly: an entry's added_at/book would be a 400.
      const fetchMock = installFetch(() => ({ status: 200, body: { queue: [entry] } }));
      await c().setQueue([entry]);
      await c().setCollectionItems(5, [entry]);
      const bare = { items: [{ library_id: entry.library_id, path: entry.path }] };
      expect(sent(fetchMock, 0).body).toEqual(bare);
      expect(sent(fetchMock, 1).body).toEqual(bare);
    });

    it('adds one book with POST /me/queue, sending position only when given', async () => {
      const fetchMock = installFetch(() => ({ status: 200, body: { queue: [entry] } }));
      await expect(c().addToQueue(2, 'Saga/Book 1')).resolves.toEqual([entry]);
      await c().addToQueue(2, 'Saga/Book 1', 0);
      expect(sent(fetchMock, 0)).toMatchObject({
        url: 'https://h/api/v1/me/queue',
        method: 'POST',
        body: { library_id: 2, path: 'Saga/Book 1' },
      });
      expect(sent(fetchMock, 1).body).toEqual({ library_id: 2, path: 'Saga/Book 1', position: 0 });
    });

    it('surfaces a full queue as a 409 ApiError', async () => {
      installFetch(() => ({ status: 409, body: { error: 'queue is full', code: 'queue_full' } }));
      await expect(c().addToQueue(2, 'Saga/Book 1')).rejects.toMatchObject({
        name: 'ApiError',
        status: 409,
        message: 'queue is full',
      });
    });

    it('removes one book with DELETE /me/queue?library_id=&path=', async () => {
      const fetchMock = installFetch(() => ({ status: 204 }));
      await expect(c().removeFromQueue(2, 'Saga/Book 1')).resolves.toBeUndefined();
      expect(sent(fetchMock)).toMatchObject({
        url: 'https://h/api/v1/me/queue?library_id=2&path=Saga%2FBook+1',
        method: 'DELETE',
        body: undefined,
      });
    });
  });

  describe('Collections', () => {
    it('lists GET /me/collections, unwrapping { collections }', async () => {
      // A viewer's entry has no shared_with at all (the server omits it).
      const { shared_with: _omitted, ...viewer } = { ...collectionWire, id: 6, owned: false };
      const fetchMock = installFetch(() => ({
        status: 200,
        body: { collections: [collectionWire, viewer] },
      }));
      const list = await c().collections();
      expect(sent(fetchMock)).toMatchObject({
        url: 'https://h/api/v1/me/collections',
        method: 'GET',
      });
      expect(list).toEqual([collectionWire, viewer]);
      expect(list[1]).not.toHaveProperty('shared_with');
    });

    it('creates with POST /me/collections and unwraps { collection }', async () => {
      const fetchMock = installFetch(() => ({ status: 201, body: { collection: collectionWire } }));
      await expect(c().createCollection({ name: 'Road trip' })).resolves.toEqual(collectionWire);
      expect(sent(fetchMock)).toMatchObject({
        url: 'https://h/api/v1/me/collections',
        method: 'POST',
        body: { name: 'Road trip' },
      });
    });

    it('sends only name and description, even given a whole cached collection', async () => {
      // The server decodes these bodies strictly: a spread Collection's other fields would
      // make the create or the rename a 400.
      const fetchMock = installFetch(() => ({ status: 200, body: { collection: collectionWire } }));
      await c().createCollection({ ...collectionWire, name: 'Road trip 2' });
      await c().updateCollection(5, { ...collectionWire, name: 'Renamed' });
      expect(sent(fetchMock, 0).body).toEqual({ name: 'Road trip 2', description: '' });
      expect(sent(fetchMock, 1).body).toEqual({ name: 'Renamed', description: '' });
    });

    it('surfaces the collections cap as a 409 ApiError', async () => {
      installFetch(() => ({ status: 409, body: { error: 'too many', code: 'collections_full' } }));
      await expect(c().createCollection({ name: 'x' })).rejects.toMatchObject({ status: 409 });
    });

    it('reads one with GET /me/collections/{id}, returning collection + items', async () => {
      const fetchMock = installFetch(() => ({
        status: 200,
        body: { collection: collectionWire, items: [entry] },
      }));
      await expect(c().collection(5)).resolves.toEqual({
        collection: collectionWire,
        items: [entry],
      });
      expect(sent(fetchMock)).toMatchObject({
        url: 'https://h/api/v1/me/collections/5',
        method: 'GET',
      });
    });

    it("surfaces a stranger's collection as a 404 ApiError", async () => {
      installFetch(() => ({ status: 404, body: { error: 'collection not found' } }));
      await expect(c().collection(99)).rejects.toMatchObject({ name: 'ApiError', status: 404 });
    });

    it('patches with PATCH /me/collections/{id}, sending only the given fields', async () => {
      const fetchMock = installFetch(() => ({ status: 200, body: { collection: collectionWire } }));
      await expect(c().updateCollection(5, { description: 'Long drives' })).resolves.toEqual(
        collectionWire,
      );
      expect(sent(fetchMock)).toMatchObject({
        url: 'https://h/api/v1/me/collections/5',
        method: 'PATCH',
        body: { description: 'Long drives' },
      });
    });

    it("surfaces a viewer's write as a 403 ApiError", async () => {
      installFetch(() => ({ status: 403, body: { error: 'not the owner', code: 'not_owner' } }));
      await expect(c().updateCollection(5, { name: 'x' })).rejects.toMatchObject({ status: 403 });
    });

    it('deletes (or leaves) with DELETE /me/collections/{id}', async () => {
      const fetchMock = installFetch(() => ({ status: 204 }));
      await expect(c().deleteCollection(5)).resolves.toBeUndefined();
      expect(sent(fetchMock)).toMatchObject({
        url: 'https://h/api/v1/me/collections/5',
        method: 'DELETE',
      });
    });

    it('replaces items with PUT /me/collections/{id}/items { items } and returns the detail', async () => {
      const fetchMock = installFetch(() => ({
        status: 200,
        body: { collection: collectionWire, items: [entry] },
      }));
      const items = [{ library_id: 2, path: 'Saga/Book 1' }];
      await expect(c().setCollectionItems(5, items)).resolves.toEqual({
        collection: collectionWire,
        items: [entry],
      });
      expect(sent(fetchMock)).toMatchObject({
        url: 'https://h/api/v1/me/collections/5/items',
        method: 'PUT',
        body: { items },
      });
    });

    it('adds one item with POST /me/collections/{id}/items and returns the detail', async () => {
      const fetchMock = installFetch(() => ({
        status: 200,
        body: { collection: collectionWire, items: [entry] },
      }));
      await expect(c().addCollectionItem(5, 2, 'Saga/Book 1', 3)).resolves.toMatchObject({
        items: [entry],
      });
      expect(sent(fetchMock)).toMatchObject({
        url: 'https://h/api/v1/me/collections/5/items',
        method: 'POST',
        body: { library_id: 2, path: 'Saga/Book 1', position: 3 },
      });
    });

    it('removes one item with DELETE /me/collections/{id}/items?library_id=&path=', async () => {
      const fetchMock = installFetch(() => ({ status: 204 }));
      await expect(c().removeCollectionItem(5, 2, 'Saga/Book 1')).resolves.toBeUndefined();
      expect(sent(fetchMock)).toMatchObject({
        url: 'https://h/api/v1/me/collections/5/items?library_id=2&path=Saga%2FBook+1',
        method: 'DELETE',
      });
    });

    it('replaces shares with PUT /me/collections/{id}/shares { user_ids }', async () => {
      const fetchMock = installFetch(() => ({ status: 200, body: { collection: collectionWire } }));
      await expect(c().setCollectionShares(5, [2, 3])).resolves.toEqual(collectionWire);
      expect(sent(fetchMock)).toMatchObject({
        url: 'https://h/api/v1/me/collections/5/shares',
        method: 'PUT',
        body: { user_ids: [2, 3] },
      });
    });

    it('lists share targets with GET /me/share-targets, unwrapping { users }', async () => {
      const users = [{ id: 2, username: 'bob' }];
      const fetchMock = installFetch(() => ({ status: 200, body: { users } }));
      await expect(c().shareTargets()).resolves.toEqual(users);
      expect(sent(fetchMock)).toMatchObject({
        url: 'https://h/api/v1/me/share-targets',
        method: 'GET',
      });
    });
  });

  describe('Ratings', () => {
    it('reads GET /libraries/{id}/rating?path=, unwrapping a rating or null', async () => {
      const fetchMock = installFetch(() => ({ status: 200, body: { rating: ratingWire } }));
      await expect(c().rating(2, 'Saga/Book 1')).resolves.toEqual(ratingWire);
      expect(sent(fetchMock)).toMatchObject({
        url: 'https://h/api/v1/libraries/2/rating?path=Saga%2FBook+1',
        method: 'GET',
      });
      installFetch(() => ({ status: 200, body: { rating: null } }));
      await expect(c().rating(2, 'Saga/Book 1')).resolves.toBeNull();
    });

    it('rates with PUT /libraries/{id}/rating?path=, sending the note only when given', async () => {
      const fetchMock = installFetch(() => ({ status: 200, body: { rating: ratingWire } }));
      await expect(c().setRating(2, 'Saga/Book 1', 4, 'Great')).resolves.toEqual(ratingWire);
      await c().setRating(2, 'Saga/Book 1', 5);
      expect(sent(fetchMock, 0)).toMatchObject({
        url: 'https://h/api/v1/libraries/2/rating?path=Saga%2FBook+1',
        method: 'PUT',
        body: { rating: 4, note: 'Great' },
      });
      expect(sent(fetchMock, 1).body).toEqual({ rating: 5 });
    });

    it('surfaces an out-of-scope path as a 403 ApiError', async () => {
      installFetch(() => ({ status: 403, body: { error: 'no access to this path' } }));
      await expect(c().setRating(2, 'Hidden', 3)).rejects.toMatchObject({
        status: 403,
        message: 'no access to this path',
      });
    });

    it('removes with DELETE /libraries/{id}/rating?path=', async () => {
      const fetchMock = installFetch(() => ({ status: 204 }));
      await expect(c().deleteRating(2, 'Saga/Book 1')).resolves.toBeUndefined();
      expect(sent(fetchMock)).toMatchObject({
        url: 'https://h/api/v1/libraries/2/rating?path=Saga%2FBook+1',
        method: 'DELETE',
      });
    });

    it('lists GET /me/ratings, unwrapping { ratings } with their books', async () => {
      const ratings = [{ ...ratingWire, book }];
      const fetchMock = installFetch(() => ({ status: 200, body: { ratings } }));
      await expect(c().myRatings()).resolves.toEqual(ratings);
      expect(sent(fetchMock)).toMatchObject({ url: 'https://h/api/v1/me/ratings', method: 'GET' });
    });
  });

  describe('Progress edit', () => {
    const progress = {
      library_id: 2,
      path: 'Saga/Book 1',
      position: 0,
      duration: 100,
      finished: false,
      playback_speed: 1,
      version: 7,
      device_id: '',
      updated_at: '2026-10-06T10:00:00Z',
      started_at: '2026-09-01T08:00:00Z',
    };

    it('edits with PATCH /libraries/{id}/progress?path= and unwraps { progress } with its dates', async () => {
      const fetchMock = installFetch(() => ({ status: 200, body: { progress } }));
      const edit = { finished: false, started_at: '2026-09-01', finished_at: null };
      await expect(c().editProgress(2, 'Saga/Book 1', edit)).resolves.toEqual(progress);
      // null is sent as null (it clears the date); absent fields stay absent.
      expect(sent(fetchMock)).toEqual({
        url: 'https://h/api/v1/libraries/2/progress?path=Saga%2FBook+1',
        method: 'PATCH',
        body: { finished: false, started_at: '2026-09-01', finished_at: null },
        contentType: 'application/json',
      });
    });

    it('sends only the edit fields, even given a whole progress row', async () => {
      const fetchMock = installFetch(() => ({ status: 200, body: { progress } }));
      await c().editProgress(2, 'Saga/Book 1', { ...progress, finished: false });
      expect(sent(fetchMock).body).toEqual({
        finished: false,
        position: 0,
        started_at: '2026-09-01T08:00:00Z',
      });
    });

    it('surfaces a rejected edit (a future date) as a 400 ApiError', async () => {
      installFetch(() => ({ status: 400, body: { error: 'date is in the future' } }));
      await expect(
        c().editProgress(2, 'Saga/Book 1', { finished_at: '2099-01-01' }),
      ).rejects.toMatchObject({ status: 400, message: 'date is in the future' });
    });

    it('passes started_at / finished_at through on the progress reads', async () => {
      const finished = { ...progress, finished: true, finished_at: '2026-10-05T21:00:00Z' };
      installFetch(() => ({ status: 200, body: { progress: [finished] } }));
      await expect(c().allProgress()).resolves.toEqual([finished]);
      installFetch(() => ({ status: 200, body: { progress: finished } }));
      await expect(c().getProgress(2, 'Saga/Book 1')).resolves.toEqual(finished);
    });
  });

  describe('Your listening', () => {
    const period = {
      range: '2026',
      from: '2026-01-01T00:00:00Z',
      to: '2026-10-06T10:00:00Z',
      timezone: 'BST',
      utc_offset: 60,
    };
    const totals = { listened: 3600, sessions: 3, books: 2, finished: 1 };
    const stats = {
      ...period,
      totals,
      previous: { listened: 0, sessions: 0, books: 0, finished: 0 },
      estimated: 120,
      days: [{ date: '2026-10-05', listened: 3600 }],
      hour_weekday: Array.from({ length: 7 }, () => Array<number>(24).fill(0)),
      top_books: [
        { library_id: 2, path: 'Saga/Book 1', title: 'Book 1', author: 'A', listened: 3600 },
      ],
      top_authors: [{ name: 'A', listened: 3600, books: 1 }],
      top_narrators: [{ name: 'N', listened: 3600, books: 1 }],
      top_series: [{ name: 'Saga', listened: 3600, books: 1 }],
      finished_books: [
        {
          library_id: 2,
          path: 'Saga/Book 1',
          title: 'Book 1',
          author: 'A',
          finished_at: '2026-10-05T21:00:00Z',
        },
      ],
      playback: [{ transcoded: false, codec: 'aac', listened: 3600, sessions: 3 }],
      clients: [{ app: 'AudioSilo', version: '1.2.0', platform: 'ios', devices: 1 }],
    };

    it('reads GET /me/stats?range= and unwraps { stats } unchanged', async () => {
      const fetchMock = installFetch(() => ({ status: 200, body: { stats } }));
      await expect(c().myStats('year')).resolves.toEqual(stats);
      expect(sent(fetchMock)).toMatchObject({
        url: 'https://h/api/v1/me/stats?range=year',
        method: 'GET',
      });
    });

    it('omits range when not given (the server reads 30d)', async () => {
      const fetchMock = installFetch(() => ({ status: 200, body: { stats } }));
      await expect(c().myStats()).resolves.toEqual(stats);
      expect(sent(fetchMock).url).toBe('https://h/api/v1/me/stats');
    });

    it('surfaces an unknown range as a 400 ApiError', async () => {
      installFetch(() => ({ status: 400, body: { error: 'invalid range' } }));
      await expect(c().myStats('1999')).rejects.toMatchObject({
        status: 400,
        message: 'invalid range',
      });
    });

    it('reads GET /me/listening?range= as is', async () => {
      const body = { ...period, days: [{ date: '2026-10-05', listened: 60 }] };
      const fetchMock = installFetch(() => ({ status: 200, body }));
      await expect(c().myListening('7d')).resolves.toEqual(body);
      expect(sent(fetchMock)).toMatchObject({
        url: 'https://h/api/v1/me/listening?range=7d',
        method: 'GET',
      });
    });

    it('reads GET /me/goal as is (a goal or null)', async () => {
      const body = {
        goal: { books_per_year: 24, updated_at: '2026-01-01T00:00:00Z' },
        year: '2026',
        finished: 9,
      };
      const fetchMock = installFetch(() => ({ status: 200, body }));
      await expect(c().listeningGoal()).resolves.toEqual(body);
      expect(sent(fetchMock)).toMatchObject({ url: 'https://h/api/v1/me/goal', method: 'GET' });
      installFetch(() => ({ status: 200, body: { goal: null, year: '2026', finished: 0 } }));
      await expect(c().listeningGoal()).resolves.toEqual({ goal: null, year: '2026', finished: 0 });
    });

    it('sets the goal with PUT /me/goal { books_per_year }', async () => {
      const body = {
        goal: { books_per_year: 30, updated_at: '2026-10-06T10:00:00Z' },
        year: '2026',
        finished: 9,
      };
      const fetchMock = installFetch(() => ({ status: 200, body }));
      await expect(c().setListeningGoal(30)).resolves.toEqual(body);
      expect(sent(fetchMock)).toMatchObject({
        url: 'https://h/api/v1/me/goal',
        method: 'PUT',
        body: { books_per_year: 30 },
      });
    });

    it('clears the goal with DELETE /me/goal', async () => {
      const fetchMock = installFetch(() => ({ status: 204 }));
      await expect(c().clearListeningGoal()).resolves.toBeUndefined();
      expect(sent(fetchMock)).toMatchObject({ url: 'https://h/api/v1/me/goal', method: 'DELETE' });
    });
  });

  describe('My devices', () => {
    const device = {
      id: 11,
      kind: 'session',
      name: 'iPhone',
      client: { app: 'AudioSilo', version: '1.2.0', platform: 'ios' },
      created_at: '2026-09-01T08:00:00Z',
      last_seen: null,
      last_ip: '',
      current: true,
    };

    it('lists GET /me/devices, unwrapping { devices }', async () => {
      const fetchMock = installFetch(() => ({ status: 200, body: { devices: [device] } }));
      await expect(c().myDevices()).resolves.toEqual([device]);
      expect(sent(fetchMock)).toMatchObject({ url: 'https://h/api/v1/me/devices', method: 'GET' });
    });

    it('revokes with DELETE /me/devices/{id} and returns { current }', async () => {
      const fetchMock = installFetch(() => ({ status: 200, body: { current: true } }));
      await expect(c().revokeMyDevice(11)).resolves.toEqual({ current: true });
      expect(sent(fetchMock)).toMatchObject({
        url: 'https://h/api/v1/me/devices/11',
        method: 'DELETE',
        body: undefined,
      });
    });

    it("surfaces someone else's or a revoked device as a 404 ApiError", async () => {
      installFetch(() => ({ status: 404, body: { error: 'device not found' } }));
      await expect(c().revokeMyDevice(12)).rejects.toMatchObject({
        name: 'ApiError',
        status: 404,
        message: 'device not found',
      });
    });
  });
});

describe('ApiClient addresses', () => {
  it('reads GET /addresses with the token, and {} when the server has neither', async () => {
    const both = { home: 'http://192.168.1.20:8080', away: 'https://books.example.com' };
    let fetchMock = installFetch(() => ({ status: 200, body: both }));
    await expect(new ApiClient('https://h', 'tok').addresses()).resolves.toEqual(both);
    expect(sent(fetchMock)).toMatchObject({ url: 'https://h/api/v1/addresses', method: 'GET' });
    expect(headerValue(fetchMock.mock.calls[0][1] as RequestInit, 'Authorization')).toBe(
      'Bearer tok',
    );
    fetchMock = installFetch(() => ({ status: 200, body: {} }));
    await expect(new ApiClient('https://h', 'tok').addresses()).resolves.toEqual({});
  });

  it('cleans the addresses where they arrive: GET /addresses and the sign-in answers', async () => {
    const raw = { home: 'ftp://nas', away: ' https://books.example.com/ ' };
    const clean = { away: 'https://books.example.com' };
    installFetch(() => ({ status: 200, body: raw }));
    await expect(new ApiClient('https://h', 'tok').addresses()).resolves.toEqual(clean);
    installFetch(() => ({ status: 200, body: { token: 't', server_id: 's', addresses: raw } }));
    expect((await new ApiClient('https://h').exchange('p', 'd')).addresses).toEqual(clean);
    expect((await new ApiClient('https://h').login('u', 'pw', 'd')).addresses).toEqual(clean);
    expect((await new ApiClient('https://h').demoSession('d')).addresses).toEqual(clean);
    expect((await new ApiClient('https://h').redeemCode('c')).addresses).toEqual(clean);
    installFetch(() => ({ status: 200, body: { home: 42 } }));
    await expect(new ApiClient('https://h', 'tok').addresses()).resolves.toEqual({});
  });
});

describe('ApiClient annotations (Phase 4)', () => {
  const c = () => new ApiClient('https://h', 'tok');
  const bookmarkWire = {
    id: 7,
    library_id: 2,
    path: 'Saga/Book 1',
    position: 61,
    note: 'Here',
    label: 'quote',
    created_at: '2026-10-01T10:00:00Z',
  };
  const noteWire = {
    id: 8,
    library_id: 2,
    path: 'Saga/Book 1',
    position: 30,
    body: 'A thought',
    created_at: '2026-10-01T10:00:00Z',
    updated_at: '2026-10-02T10:00:00Z',
  };
  const span = {
    id: 9,
    library_id: 2,
    path: 'Saga/Book 1',
    from_pos: 0,
    to_pos: 60,
    started_at: '2026-10-01T10:00:00Z',
    ended_at: '2026-10-01T10:01:00Z',
  };

  it('adds a bookmark with POST, sending label only when given', async () => {
    const fetchMock = installFetch(() => ({ status: 201, body: bookmarkWire }));
    await expect(c().addBookmark(2, 'Saga/Book 1', 61, 'Here', 'quote')).resolves.toEqual(
      bookmarkWire,
    );
    await c().addBookmark(2, 'Saga/Book 1', 61);
    expect(sent(fetchMock, 0)).toEqual({
      url: 'https://h/api/v1/libraries/2/bookmarks?path=Saga%2FBook+1',
      method: 'POST',
      body: { position: 61, note: 'Here', label: 'quote' },
      contentType: 'application/json',
    });
    // An older server rejects an unknown field, so no label means no `label` key at all.
    expect(sent(fetchMock, 1).body).toEqual({ position: 61, note: '' });
  });

  it('edits a bookmark with PATCH /bookmarks/{id}, sending only the given fields', async () => {
    const fetchMock = installFetch(() => ({ status: 200, body: bookmarkWire }));
    await expect(c().updateBookmark(7, { label: 'quote' })).resolves.toEqual(bookmarkWire);
    // A spread cached row carries id/position/...: only note and label go out.
    await c().updateBookmark(7, { ...bookmarkWire, label: '' } as never);
    expect(sent(fetchMock, 0)).toEqual({
      url: 'https://h/api/v1/bookmarks/7',
      method: 'PATCH',
      body: { label: 'quote' },
      contentType: 'application/json',
    });
    expect(sent(fetchMock, 1).body).toEqual({ note: 'Here', label: '' });
  });

  it('edits a note with PATCH /notes/{id}, sending only the given fields', async () => {
    const fetchMock = installFetch(() => ({ status: 200, body: noteWire }));
    await expect(c().updateNote(8, { body: 'A thought' })).resolves.toEqual(noteWire);
    await c().updateNote(8, { ...noteWire, position: 0 } as never);
    expect(sent(fetchMock, 0)).toEqual({
      url: 'https://h/api/v1/notes/8',
      method: 'PATCH',
      body: { body: 'A thought' },
      contentType: 'application/json',
    });
    expect(sent(fetchMock, 1).body).toEqual({ body: 'A thought', position: 0 });
  });

  it("surfaces someone else's bookmark or note as a 404 ApiError", async () => {
    installFetch(() => ({ status: 404, body: { error: 'bookmark not found' } }));
    await expect(c().updateBookmark(99, { note: 'x' })).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
      message: 'bookmark not found',
    });
  });

  it('pages GET /me/bookmarks into { items, next_cursor }', async () => {
    const row = { ...bookmarkWire, book };
    const fetchMock = installFetch(() => ({
      status: 200,
      body: { bookmarks: [row], next_cursor: 'abc' },
    }));
    await expect(c().myBookmarks({ limit: 50, cursor: 'xyz' })).resolves.toEqual({
      items: [row],
      next_cursor: 'abc',
    });
    await c().myBookmarks();
    expect(sent(fetchMock, 0)).toMatchObject({
      url: 'https://h/api/v1/me/bookmarks?limit=50&cursor=xyz',
      method: 'GET',
    });
    expect(sent(fetchMock, 1).url).toBe('https://h/api/v1/me/bookmarks');
  });

  it('pages GET /me/notes, reading a last page (no cursor, null rows) as none more', async () => {
    const fetchMock = installFetch(() => ({ status: 200, body: { notes: null } }));
    await expect(c().myNotes({ cursor: 'n2' })).resolves.toEqual({ items: [] });
    expect(sent(fetchMock)).toMatchObject({
      url: 'https://h/api/v1/me/notes?cursor=n2',
      method: 'GET',
    });
  });

  it('pages GET /me/history, and reads an older server (no next_cursor) as one page', async () => {
    const fetchMock = installFetch((url) =>
      url.includes('cursor')
        ? { status: 200, body: { history: [{ ...span, book }] } }
        : { status: 200, body: { history: [span], next_cursor: 'h2' } },
    );
    await expect(c().allHistory({ limit: 100 })).resolves.toEqual({
      items: [span],
      next_cursor: 'h2',
    });
    await expect(c().allHistory({ limit: 100, cursor: 'h2' })).resolves.toEqual({
      items: [{ ...span, book }],
    });
    expect(sent(fetchMock, 0)).toMatchObject({
      url: 'https://h/api/v1/me/history?limit=100',
      method: 'GET',
    });
    expect(sent(fetchMock, 1).url).toBe('https://h/api/v1/me/history?limit=100&cursor=h2');
  });
});
