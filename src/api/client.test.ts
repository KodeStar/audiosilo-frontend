import { Platform } from 'react-native';

import {
  ApiClient,
  ApiError,
  apiErrorKind,
  isPlainSeriesQuery,
  PodcastFetchPendingError,
  SERIES_BATCH_MAX_QUERY_BYTES,
  SERIES_BOOKS_MAX_NAMES,
} from '@/api/client';
import type { AddMemberBody, BridgeEstimate, Listing, SidecarsGenerateResult } from '@/api/types';
import { podcastEpisode, podcastShow, wire2b } from '@/testing/podcast-fixtures';
import { golden2c3, goldenBytes, goldenError, goldenText } from '@/testing/podcast-fixtures-2c3';

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

/** A fetch that never resolves until its signal aborts. */
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

  it("carries the error body's code, and none when the body has none", async () => {
    installFetch(() => ({
      status: 409,
      body: { error: 'member limit reached', code: 'member_limit' },
    }));
    const coded = await new ApiClient('https://h', 'tok')
      .addMember({ name: 'Evie', kind: 'kid', access: 'collections' })
      .catch((e: unknown) => e);
    expect(coded).toBeInstanceOf(ApiError);
    expect(coded).toMatchObject({ status: 409, code: 'member_limit' });

    installFetch(() => ({ status: 403, body: { error: 'forbidden' } }));
    const plain = await new ApiClient('https://h', 'tok').me().catch((e: unknown) => e);
    expect(plain).toMatchObject({ status: 403, message: 'forbidden' });
    expect((plain as ApiError).code).toBeUndefined();

    // A code that is not a string is no code.
    installFetch(() => ({ status: 400, body: { error: 'bad', code: 7 } }));
    const odd = await new ApiClient('https://h', 'tok').me().catch((e: unknown) => e);
    expect((odd as ApiError).code).toBeUndefined();
  });

  it("apiErrorKind: the server's code when the app knows it, else the status's kind", () => {
    expect(apiErrorKind(new ApiError(409, 'x', 'member_limit'))).toBe('member_limit');
    expect(apiErrorKind(new ApiError(403, 'x', 'kid_account'))).toBe('kid_account');
    // A member the admin disabled (their session or pairing): not the generic 409.
    expect(apiErrorKind(new ApiError(409, 'x', 'member_disabled'))).toBe('member_disabled');
    // A generate job for a book whose chapters are still being found (Bridge Phase 1d).
    expect(apiErrorKind(new ApiError(409, 'x', 'detect_open'))).toBe('detect_open');
    // One for a book whose characters and recaps are being shared (Bridge Phase 2b).
    expect(apiErrorKind(new ApiError(409, 'x', 'contribute_open'))).toBe('contribute_open');
    // A code the app doesn't know reads by its status.
    expect(apiErrorKind(new ApiError(409, 'x', 'collection_full'))).toBe('conflict');
    expect(apiErrorKind(new ApiError(429, 'too many attempts'))).toBe('too_many');
    expect(apiErrorKind(new ApiError(404, 'x'))).toBe('not_found');
    expect(apiErrorKind(new ApiError(403, 'x'))).toBe('forbidden');
    expect(apiErrorKind(new ApiError(400, 'x'))).toBe('invalid');
    expect(apiErrorKind(new ApiError(500, 'x'))).toBe('failed');
    // No answer at all.
    expect(apiErrorKind(new TypeError('Network request failed'))).toBe('failed');
    expect(apiErrorKind(undefined)).toBe('failed');
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

  // server#193: the wire shape of a folder the scan has not reached that the server
  // would read as a book, passed through as-is; an older server's entry has no flag.
  it('browses GET /libraries/{id}/fs and passes pending_book through', async () => {
    const listing: Listing = {
      path: 'Author X',
      entries: [
        {
          name: 'New Book',
          path: 'Author X/New Book',
          is_dir: true,
          is_audio: false,
          size: 0,
          mod_time: 0,
          pending_book: true,
        },
        // An older server (or a plain folder): no pending_book key at all.
        {
          name: 'Artwork',
          path: 'Author X/Artwork',
          is_dir: true,
          is_audio: false,
          size: 0,
          mod_time: 0,
        },
      ],
      total: 2,
      offset: 0,
    };
    const fetchMock = installFetch(() => ({ status: 200, body: listing }));
    const got = await new ApiClient('https://h', 'tok').browse(2, 'Author X');
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://h/api/v1/libraries/2/fs?path=Author+X',
    );
    expect(got.entries[0].pending_book).toBe(true);
    expect(got.entries[1].pending_book).toBeUndefined();
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

  it('passes through an unmatched book with generated content in work (Bridge 1a)', async () => {
    // The server's answer for a book its Bridge generated characters and recaps for, with
    // no community match: the work carries only the generated dimensions.
    const envelope = {
      matched: false,
      work: {
        id: '',
        title: 'The Home Recording',
        characters: [{ id: 'ada', name: 'Ada', reveal: { chapter: 1 } }],
        recaps: [{ through: { chapter: 3 }, text: 'So far.' }],
        recap_summary: { in_short: 'All of it.' },
        generated: { characters: true, recaps: true, generated_at: '2026-10-15T09:00:00Z' },
      },
    };
    installFetch(() => ({ status: 200, body: envelope }));
    const meta = await new ApiClient('https://h', 'tok').bookMeta(1, 'x');
    expect(meta).toEqual(envelope);
    expect(meta.matched).toBe(false);
    expect(meta.work?.generated).toEqual({
      characters: true,
      recaps: true,
      generated_at: '2026-10-15T09:00:00Z',
    });
  });

  it('passes through a generated description, matched or not (Bridge 1c)', async () => {
    // A matched work without a community description carries the description the Bridge
    // wrote on this server; an unmatched book with only a description carries it in work.
    const matched = {
      matched: true,
      work: {
        id: 'the-martian',
        title: 'The Martian',
        authors: [{ id: 'andy-weir', name: 'Andy Weir' }],
        language: 'en',
        generated_description: { text: 'Written here.' },
        generated: { description: true, generated_at: '2026-10-16T09:00:00Z' },
      },
      web_url: 'https://meta.audiosilo.app/work?id=the-martian',
    };
    const unmatched = {
      matched: false,
      work: {
        id: '',
        title: 'The Home Recording',
        authors: [],
        language: '',
        generated_description: { text: 'Written here too.' },
        generated: { description: true, generated_at: '2026-10-16T09:00:00Z' },
      },
    };
    installFetch(() => ({ status: 200, body: matched }));
    const m = await new ApiClient('https://h', 'tok').bookMeta(1, 'x');
    expect(m).toEqual(matched);
    expect(m.work?.generated_description).toEqual({ text: 'Written here.' });
    expect(m.work?.generated?.description).toBe(true);
    installFetch(() => ({ status: 200, body: unmatched }));
    const u = await new ApiClient('https://h', 'tok').bookMeta(1, 'x');
    expect(u).toEqual(unmatched);
    expect(u.matched).toBe(false);
    expect(u.work?.generated_description?.text).toBe('Written here too.');
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

  // --- Community covers (meta_covers) ------------------------------------------

  it('builds the community cover URL from the book and its cover_url, with the media token', () => {
    const c = new ApiClient('https://h', 'tok');
    expect(
      c.communityCoverUrl(3, 'A/Book', 'https://m.media-amazon.com/images/I/x.jpg?a=1&b=2', {
        size: 160,
      }),
    ).toBe(
      'https://h/api/v1/libraries/3/meta/cover?path=A%2FBook' +
        '&url=https%3A%2F%2Fm.media-amazon.com%2Fimages%2FI%2Fx.jpg%3Fa%3D1%26b%3D2' +
        '&size=160&token=tok',
    );
    // No size: the server's default thumbnail. No token: none in the URL.
    expect(new ApiClient('https://h').communityCoverUrl(3, 'A/Book', 'https://c/1.jpg')).toBe(
      'https://h/api/v1/libraries/3/meta/cover?path=A%2FBook&url=https%3A%2F%2Fc%2F1.jpg',
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

  // "community": a community recording's list; "generated" (Bridge Phase 1d): chapters a
  // Bridge found in the narration of a chapterless book.
  it.each(['community', 'generated'] as const)(
    'passes chapters_source %s through on the chapters and item envelopes',
    async (source) => {
      const fetchMock = installFetch((url) => ({
        status: 200,
        body: url.includes('/chapters')
          ? { ...chaptersBody, chapters_source: source }
          : { id: 9, rel_path: 'Myths/Mythos', chapters_source: source },
      }));
      const c = new ApiClient('https://h', 'tok');
      const data = await c.chapters(2, 'Myths/Mythos');
      expect(String(fetchMock.mock.calls[0][0])).toContain(
        '/libraries/2/chapters?path=Myths%2FMythos',
      );
      // Typed reads, so a misnamed mirror field fails the type check, not only a match.
      expect(data.chapters_source).toBe(source);
      expect(data.chapters[0].title).toBe('Chaos');
      const book = await c.item(2, 'Myths/Mythos');
      expect(book.chapters_source).toBe(source);
    },
  );

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

  it('lists books by a genre or a tag, encoded', async () => {
    const fetchMock = installFetch(() => ({ status: 200, body: { books: [] } }));
    const c = new ApiClient('https://h', 'tok');
    await c.listBooks(2, { genre: 'Science Fiction & Fantasy', limit: 200 });
    await c.listBooks(2, { tag: 'to-read', sort: 'recent' });
    await c.listBooks(2, { genre: undefined, tag: undefined });
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      'https://h/api/v1/libraries/2/books?genre=Science+Fiction+%26+Fantasy&limit=200',
      'https://h/api/v1/libraries/2/books?tag=to-read&sort=recent',
      'https://h/api/v1/libraries/2/books',
    ]);
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
        // The Bridge's estimate asks the community what the book and its series have.
        settle('estimate', c.bridgeEstimate(2, 'Saga/Book 2', 'sidecars.generate')),
      ];
      await jest.advanceTimersByTimeAsync(15_000);
      expect(Object.keys(outcomes)).toEqual(['plain']);
      await jest.advanceTimersByTimeAsync(15_000);
      await Promise.all(pending);
      expect(outcomes.next).toMatchObject({ name: 'TimeoutError', timeoutMs: 30_000 });
      expect(outcomes.previous).toMatchObject({ name: 'TimeoutError', timeoutMs: 30_000 });
      expect(outcomes.estimate).toMatchObject({ name: 'TimeoutError', timeoutMs: 30_000 });
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

  // --- onAnswer (FU-SLOWOK: every HTTP answer counts for reachability) -----------
  it('fires onAnswer for every response, whatever its status', async () => {
    const onAnswer = jest.fn();
    installFetch(() => ({ status: 200, body: { name: 'AudioSilo' } }));
    const c = new ApiClient('https://h', 'tok', undefined, undefined, onAnswer);
    await c.serverInfo();
    installFetch(() => ({ status: 503, body: { error: 'busy' } }));
    await expect(c.me()).rejects.toMatchObject({ status: 503 });
    expect(onAnswer).toHaveBeenCalledTimes(2);
  });

  it('does NOT fire onAnswer when nothing answered (a timeout or a fetch rejection)', async () => {
    const onAnswer = jest.fn();
    installHangingFetch();
    const c = new ApiClient('https://h', 'tok', 10, undefined, onAnswer);
    await expect(c.serverInfo()).rejects.toMatchObject({ name: 'TimeoutError' });
    globalThis.fetch = jest.fn(() =>
      Promise.reject(new TypeError('Network request failed')),
    ) as unknown as typeof globalThis.fetch;
    await expect(c.serverInfo()).rejects.toBeInstanceOf(TypeError);
    expect(onAnswer).not.toHaveBeenCalled();
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

describe('ApiClient.addHistory', () => {
  const span = {
    from_pos: 10,
    to_pos: 55,
    started_at: '2026-10-02T10:00:00Z',
    ended_at: '2026-10-02T10:00:45Z',
  };

  it('posts the span, as a keepalive request only when the page is going (PLAYER-03)', async () => {
    const fetchMock = installFetch(() => ({ status: 204 }));
    const c = new ApiClient('https://h', 'tok');
    await c.addHistory(2, 'Saga/Book 1', span);
    await c.addHistory(2, 'Saga/Book 1', span, { keepalive: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://h/api/v1/libraries/2/history?path=Saga%2FBook+1');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual(span);
    expect(init.keepalive).toBeUndefined();
    expect((fetchMock.mock.calls[1] as [string, RequestInit])[1].keepalive).toBe(true);
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

describe('ApiClient series books (series_books)', () => {
  /** A server answering GET /libraries/{id}/series/books: per distinct name, one book
   * titled after it and a cursor to its second page. */
  function seriesServer() {
    return installFetch((url) => {
      const names = [...new Set(new URL(url).searchParams.getAll('name'))];
      return {
        status: 200,
        body: {
          series: names.map((name) => ({
            name,
            books: [{ title: name }],
            next_cursor: `${name}-2`,
          })),
        },
      };
    });
  }
  const namesOf = (fetchMock: jest.Mock, i: number) =>
    new URL(sent(fetchMock, i).url).searchParams.getAll('name');

  it('asks for several series at once with the name repeated, the list unwrapped', async () => {
    const fetchMock = installFetch(() => ({
      status: 200,
      body: {
        series: [
          { name: 'A & B', books: null },
          { name: 'C', books: [{ id: 1 }] },
        ],
      },
    }));
    const entries = await new ApiClient('https://h', 'tok').seriesBooks(2, ['A & B', 'C'], {
      limit: 100,
    });
    expect(sent(fetchMock).url).toBe(
      'https://h/api/v1/libraries/2/series/books?name=A+%26+B&name=C&limit=100',
    );
    expect(entries).toEqual([
      { name: 'A & B', books: [] },
      { name: 'C', books: [{ id: 1 }] },
    ]);
  });

  it('answers every series asked for within the window with one request', async () => {
    const fetchMock = seriesServer();
    const c = new ApiClient('https://h', 'tok');
    const pages = await Promise.all([
      c.seriesBooksPage(2, 'Discworld', { limit: 100 }),
      c.seriesBooksPage(2, 'City Watch / Night', { limit: 100 }),
      c.seriesBooksPage(2, 'Discworld', { limit: 100 }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sent(fetchMock).url).toBe(
      'https://h/api/v1/libraries/2/series/books?name=Discworld&name=City+Watch+%2F+Night&limit=100',
    );
    expect(pages).toEqual([
      { books: [{ title: 'Discworld' }], next_cursor: 'Discworld-2' },
      { books: [{ title: 'City Watch / Night' }], next_cursor: 'City Watch / Night-2' },
      { books: [{ title: 'Discworld' }], next_cursor: 'Discworld-2' },
    ]);
  });

  it('splits more than 50 names into requests of at most 50', async () => {
    const fetchMock = seriesServer();
    const c = new ApiClient('https://h', 'tok');
    const names = Array.from({ length: 51 }, (_, i) => `S${i}`);
    const pages = await Promise.all(names.map((n) => c.seriesBooksPage(2, n)));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(namesOf(fetchMock, 0)).toEqual(names.slice(0, SERIES_BOOKS_MAX_NAMES));
    expect(namesOf(fetchMock, 1)).toEqual(['S50']);
    expect(pages.map((p) => p.books[0].title)).toEqual(names);
  });

  it('keeps each request line short: long names split a batch before 50', async () => {
    const fetchMock = seriesServer();
    const c = new ApiClient('https://h', 'tok');
    // 30 characters of CJK: 270 bytes encoded, so fewer than 50 fit the budget.
    const names = Array.from({ length: 20 }, (_, i) => `${'\u5DE8'.repeat(30)}${i}`);
    const pages = await Promise.all(names.map((n) => c.seriesBooksPage(2, n)));
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    const sentNames = fetchMock.mock.calls.flatMap((_, i) => namesOf(fetchMock, i));
    expect(sentNames).toEqual(names);
    for (let i = 0; i < fetchMock.mock.calls.length; i++) {
      const query = new URL(sent(fetchMock, i).url).search;
      expect(query.length).toBeLessThan(SERIES_BATCH_MAX_QUERY_BYTES + 100);
    }
    expect(pages.map((p) => p.books[0].title)).toEqual(names);
  });

  it('sends a request per library and per limit', async () => {
    const fetchMock = seriesServer();
    const c = new ApiClient('https://h', 'tok');
    await Promise.all([
      c.seriesBooksPage(2, 'A'),
      c.seriesBooksPage(3, 'B'),
      c.seriesBooksPage(2, 'C', { limit: 20 }),
      c.seriesBooksPage(2, 'D'),
    ]);
    expect(fetchMock.mock.calls.map((call) => String(call[0])).sort()).toEqual([
      'https://h/api/v1/libraries/2/series/books?name=A&name=D',
      'https://h/api/v1/libraries/2/series/books?name=C&limit=20',
      'https://h/api/v1/libraries/3/series/books?name=B',
    ]);
  });

  it('starts a new batch once the window has closed', async () => {
    const fetchMock = seriesServer();
    const c = new ApiClient('https://h', 'tok');
    await c.seriesBooksPage(2, 'A');
    await c.seriesBooksPage(2, 'B');
    expect([namesOf(fetchMock, 0), namesOf(fetchMock, 1)]).toEqual([['A'], ['B']]);
  });

  it('rejects every caller in a failed request, and only those', async () => {
    const fetchMock = installFetch((url) =>
      new URL(url).pathname.includes('/libraries/2/')
        ? { status: 500, body: { error: 'boom' } }
        : { status: 200, body: { series: [{ name: 'C', books: [] }] } },
    );
    const c = new ApiClient('https://h', 'tok');
    const results = await Promise.allSettled([
      c.seriesBooksPage(2, 'A'),
      c.seriesBooksPage(2, 'B'),
      c.seriesBooksPage(3, 'C'),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected', 'fulfilled']);
    expect((results[0] as PromiseRejectedResult).reason).toMatchObject({
      name: 'ApiError',
      status: 500,
    });
  });

  it('rejects a caller whose name the answer leaves out, the others answered', async () => {
    installFetch(() => ({ status: 200, body: { series: [{ name: 'A', books: [] }] } }));
    const c = new ApiClient('https://h', 'tok');
    const [a, b] = await Promise.allSettled([c.seriesBooksPage(2, 'A'), c.seriesBooksPage(2, 'B')]);
    expect(a).toEqual({ status: 'fulfilled', value: { books: [] } });
    expect(b.status).toBe('rejected');
  });

  it('knows a plain series query by having no other key', () => {
    expect(isPlainSeriesQuery({ series: 'A', memberships: true })).toBe(true);
    // The batch always answers with memberships, so a list without them isn't one.
    expect(isPlainSeriesQuery({ series: 'A' })).toBe(false);
    expect(isPlainSeriesQuery({ series: 'A', memberships: false })).toBe(false);
    // An unset or empty filter is no filter.
    const m = { memberships: true };
    expect(isPlainSeriesQuery({ series: 'A', ...m, author: undefined, narrator: '' })).toBe(true);
    expect(isPlainSeriesQuery(m)).toBe(false);
    expect(isPlainSeriesQuery({ series: 'A', ...m, sort: 'title' })).toBe(false);
    expect(isPlainSeriesQuery({ series: 'A', ...m, author: 'X' })).toBe(false);
    // A key BookListQuery doesn't have today is not answered by the batch either.
    expect(isPlainSeriesQuery({ series: 'A', ...m, genre: 'x' } as never)).toBe(false);
  });

  it('gives a batched request the client timeout', async () => {
    installHangingFetch();
    const c = new ApiClient('https://h', 'tok', 10); // 10ms timeout
    await expect(c.seriesBooksPage(2, 'A')).rejects.toMatchObject({ name: 'TimeoutError' });
  });
});

describe('ApiClient household and cast (Phase 8)', () => {
  const c = () => new ApiClient('https://h', 'tok');
  // The server's exact answers (audiosilo-server internal/api household_test.go).
  const houseRow = {
    user_id: 3,
    username: 'sam',
    library_id: 1,
    path: 'Will Wight/Cradle',
    title: 'Unsouled',
    author: 'Will Wight',
    state: 'playing',
    position: 1234.5,
    duration: 36000,
    chapter: 'Chapter 4',
    chapter_index: 3,
    updated_at: '2026-10-09T19:59:30.000Z',
  };

  it('reads GET /me/household as is', async () => {
    const fetchMock = installFetch(() => ({ status: 200, body: { share_listening: false } }));
    await expect(c().household()).resolves.toEqual({ share_listening: false });
    expect(sent(fetchMock)).toMatchObject({
      url: 'https://h/api/v1/me/household',
      method: 'GET',
      body: undefined,
    });
  });

  it('sets it with PUT /me/household { share_listening } only', async () => {
    const fetchMock = installFetch(() => ({ status: 200, body: { share_listening: true } }));
    await expect(c().setHousehold(true)).resolves.toEqual({ share_listening: true });
    expect(sent(fetchMock)).toEqual({
      url: 'https://h/api/v1/me/household',
      method: 'PUT',
      body: { share_listening: true },
      contentType: 'application/json',
    });
  });

  it("surfaces a demo account's refusal as a 403 ApiError", async () => {
    installFetch(() => ({ status: 403, body: { error: 'not available for demo accounts' } }));
    await expect(c().setHousehold(true)).rejects.toMatchObject({
      name: 'ApiError',
      status: 403,
    });
  });

  it('reads GET /household/listening, every row field round-tripped', async () => {
    const body = {
      sharing: true,
      listening: [
        houseRow,
        {
          ...houseRow,
          user_id: 4,
          author: null,
          duration: null,
          chapter: null,
          chapter_index: null,
          state: 'recent',
        },
      ],
    };
    const fetchMock = installFetch(() => ({ status: 200, body }));
    await expect(c().houseListening()).resolves.toEqual(body);
    expect(sent(fetchMock)).toMatchObject({
      url: 'https://h/api/v1/household/listening',
      method: 'GET',
    });
  });

  it('reads a caller who does not share as { sharing: false, listening: [] }', async () => {
    installFetch(() => ({ status: 200, body: { sharing: false, listening: [] } }));
    await expect(c().houseListening()).resolves.toEqual({ sharing: false, listening: [] });
    installFetch(() => ({ status: 200, body: { sharing: false, listening: null } }));
    await expect(c().houseListening()).resolves.toEqual({ sharing: false, listening: [] });
  });

  it('mints with POST /cast/token { library_id, path } and returns { token, expires_at }', async () => {
    const minted = { token: 'cast-secret', expires_at: '2026-10-10T20:00:00.000Z' };
    const fetchMock = installFetch(() => ({ status: 201, body: minted }));
    await expect(c().castToken(2, 'Saga/Book 1')).resolves.toEqual(minted);
    expect(sent(fetchMock)).toEqual({
      url: 'https://h/api/v1/cast/token',
      method: 'POST',
      body: { library_id: 2, path: 'Saga/Book 1' },
      contentType: 'application/json',
    });
  });

  it("surfaces a book outside the caller's access as a 403 ApiError", async () => {
    installFetch(() => ({ status: 403, body: { error: 'no access to this path' } }));
    await expect(c().castToken(2, 'Other/Book')).rejects.toMatchObject({ status: 403 });
  });

  it("tells an episode's refusal apart by its code (server v2.4.0), and an older one by status", async () => {
    installFetch(() => ({
      status: 403,
      body: { error: 'Only a book can be cast.', code: 'not_a_book' },
    }));
    const e = await c()
      .castToken(3, 'Show/episode.mp3')
      .catch((err: unknown) => err);
    expect(e).toMatchObject({ name: 'ApiError', status: 403, code: 'not_a_book' });
    expect(apiErrorKind(e)).toBe('not_a_book');
    installFetch(() => ({ status: 403, body: { error: 'no access to this library' } }));
    expect(
      apiErrorKind(
        await c()
          .castToken(3, 'Show/episode.mp3')
          .catch((err: unknown) => err),
      ),
    ).toBe('forbidden');
  });
});

describe('ApiClient household members (Phase 8b-1)', () => {
  const c = () => new ApiClient('https://h', 'tok');
  const evie = {
    id: 12,
    name: 'Evie',
    username: 'evie',
    kind: 'kid',
    access: 'collections',
    created_at: '2026-10-13T10:00:00.000Z',
    collections: [{ id: 4, name: "Evie's books", items: 2 }],
    devices: 1,
    last_listened_at: '2026-10-13T18:00:00.000Z',
  };
  const ellis = {
    id: 13,
    name: 'Ellis',
    username: 'ellis',
    kind: 'grownup',
    access: 'all',
    created_at: '2026-10-13T11:00:00.000Z',
    devices: 0,
    last_listened_at: null,
  };
  const session = {
    token: 'member-secret',
    server_id: 'srv',
    user: {
      id: 12,
      username: 'evie',
      role: 'user',
      disabled: false,
      has_password: false,
      has_recovery: false,
      managed_by: { id: 1, username: 'adam' },
      member_kind: 'kid',
    },
    addresses: { home: 'http://192.168.1.5:8080', away: 'nonsense' },
  };
  const device = {
    id: 21,
    kind: 'session',
    name: "Adam's iPhone",
    client: null,
    created_at: '2026-10-13T10:00:00.000Z',
    last_seen: null,
    last_ip: '',
    current: false,
  };

  it('lists GET /me/household/members, every field round-tripped', async () => {
    const body = { allowed: true, max: 6, members: [evie, ellis] };
    const fetchMock = installFetch(() => ({ status: 200, body }));
    await expect(c().members()).resolves.toEqual(body);
    expect(sent(fetchMock)).toEqual({
      url: 'https://h/api/v1/me/household/members',
      method: 'GET',
      body: undefined,
      contentType: undefined,
    });
  });

  it('reads a refusal reason, and a null members list as []', async () => {
    installFetch(() => ({
      status: 200,
      body: { allowed: false, reason: 'member', max: 6, members: null },
    }));
    await expect(c().members()).resolves.toEqual({
      allowed: false,
      reason: 'member',
      max: 6,
      members: [],
    });
  });

  it('adds with POST /me/household/members and the exact body', async () => {
    const fetchMock = installFetch(() => ({ status: 201, body: { member: ellis } }));
    const body = { name: 'Ellis', kind: 'grownup', access: 'all' } as const;
    await expect(c().addMember(body)).resolves.toEqual({ member: ellis });
    expect(sent(fetchMock)).toEqual({
      url: 'https://h/api/v1/me/household/members',
      method: 'POST',
      body,
      contentType: 'application/json',
    });
  });

  it('adds signed in here: sends sign_in_here and collection_ids, cleans the session addresses', async () => {
    const fetchMock = installFetch(() => ({ status: 201, body: { member: evie, session } }));
    const body: AddMemberBody = {
      name: 'Evie',
      kind: 'kid',
      access: 'collections',
      sign_in_here: true,
      collection_ids: [4],
    };
    await expect(c().addMember(body)).resolves.toEqual({
      member: evie,
      session: { ...session, addresses: { home: 'http://192.168.1.5:8080' } },
    });
    expect(sent(fetchMock).body).toEqual(body);
  });

  it('surfaces a refusal to add as a coded ApiError', async () => {
    installFetch(() => ({ status: 409, body: { error: 'member limit reached' } }));
    await expect(c().addMember({ name: 'Evie', kind: 'kid', access: 'all' })).rejects.toMatchObject(
      { name: 'ApiError', status: 409, message: 'member limit reached' },
    );
  });

  it('signs a member in here with POST .../{id}/session (no body), addresses cleaned', async () => {
    const fetchMock = installFetch(() => ({ status: 201, body: session }));
    await expect(c().memberSession(12)).resolves.toEqual({
      ...session,
      addresses: { home: 'http://192.168.1.5:8080' },
    });
    expect(sent(fetchMock)).toEqual({
      url: 'https://h/api/v1/me/household/members/12/session',
      method: 'POST',
      body: undefined,
      contentType: undefined,
    });
  });

  it('mints a pairing with POST .../{id}/pair (no body)', async () => {
    const pairing = {
      server_name: 'Home',
      base_url: 'https://h',
      pairing_token: 'pt',
      uri: 'audiosilo://connect?server=https%3A%2F%2Fh&token=pt',
      web_url: 'https://h/web/connect?token=pt',
      qr_png_data_uri: 'data:image/png;base64,AA',
      links: { web: 'https://h/web', admin: 'https://h/admin' },
    };
    const fetchMock = installFetch(() => ({ status: 200, body: pairing }));
    await expect(c().memberPairing(13)).resolves.toEqual({ ...pairing, addresses: undefined });
    expect(sent(fetchMock)).toEqual({
      url: 'https://h/api/v1/me/household/members/13/pair',
      method: 'POST',
      body: undefined,
      contentType: undefined,
    });
  });

  it("lists a member's devices with GET .../{id}/devices (a bare array)", async () => {
    const fetchMock = installFetch(() => ({ status: 200, body: [device] }));
    await expect(c().memberDevices(12)).resolves.toEqual([device]);
    expect(sent(fetchMock)).toMatchObject({
      url: 'https://h/api/v1/me/household/members/12/devices',
      method: 'GET',
      body: undefined,
    });
    installFetch(() => ({ status: 200, body: null }));
    await expect(c().memberDevices(12)).resolves.toEqual([]);
  });

  it('signs a member out of a device with DELETE .../{id}/devices/{device_id}', async () => {
    const fetchMock = installFetch(() => ({ status: 204 }));
    await expect(c().revokeMemberDevice(12, 21)).resolves.toBeUndefined();
    expect(sent(fetchMock)).toEqual({
      url: 'https://h/api/v1/me/household/members/12/devices/21',
      method: 'DELETE',
      body: undefined,
      contentType: undefined,
    });
  });

  it('changes a member with PATCH .../{id}, only the given fields', async () => {
    const changed = { ...evie, name: 'Evie B', kind: 'grownup' };
    const fetchMock = installFetch(() => ({ status: 200, body: changed }));
    await expect(c().updateMember(12, { name: 'Evie B', kind: 'grownup' })).resolves.toEqual(
      changed,
    );
    expect(sent(fetchMock)).toEqual({
      url: 'https://h/api/v1/me/household/members/12',
      method: 'PATCH',
      body: { name: 'Evie B', kind: 'grownup' },
      contentType: 'application/json',
    });
    const again = installFetch(() => ({ status: 200, body: evie }));
    await c().updateMember(12, { access: 'collections', collection_ids: [] });
    expect(sent(again).body).toEqual({ access: 'collections', collection_ids: [] });
  });

  it('deletes a member with DELETE .../{id}', async () => {
    const fetchMock = installFetch(() => ({ status: 204 }));
    await expect(c().deleteMember(12)).resolves.toBeUndefined();
    expect(sent(fetchMock)).toEqual({
      url: 'https://h/api/v1/me/household/members/12',
      method: 'DELETE',
      body: undefined,
      contentType: undefined,
    });
  });

  it("reads a member's 404 as an ApiError", async () => {
    installFetch(() => ({ status: 404, body: { error: 'member not found' } }));
    await expect(c().deleteMember(99)).rejects.toMatchObject({ name: 'ApiError', status: 404 });
  });

  it('revokes a device with ?also_members=1 only when asked', async () => {
    const answer = { current: false, members_signed_out: 2 };
    const fetchMock = installFetch(() => ({ status: 200, body: answer }));
    await expect(c().revokeMyDevice(11, { alsoMembers: true })).resolves.toEqual(answer);
    expect(sent(fetchMock)).toEqual({
      url: 'https://h/api/v1/me/devices/11?also_members=1',
      method: 'DELETE',
      body: undefined,
      contentType: undefined,
    });
    const off = installFetch(() => ({ status: 200, body: { current: false } }));
    await c().revokeMyDevice(11, { alsoMembers: false });
    await c().revokeMyDevice(11, {});
    await c().revokeMyDevice(11);
    for (const i of [0, 1, 2]) expect(sent(off, i).url).toBe('https://h/api/v1/me/devices/11');
  });

  it('reads member_sign_ins on GET /me/devices', async () => {
    const row = { ...device, current: true, member_sign_ins: [{ id: 12, name: 'Evie' }] };
    installFetch(() => ({ status: 200, body: { devices: [row] } }));
    await expect(c().myDevices()).resolves.toEqual([row]);
  });
});

describe('ApiClient Bridge (admin, Phase 1a)', () => {
  const c = () => new ApiClient('https://h', 'tok');
  // The server's Job JSON (audiosilo-server internal/bridge jobs.go), every field.
  const job = {
    id: 12,
    kind: 'sidecars.generate',
    library_id: 1,
    path: 'Author/Series/Book 2',
    params: { source: 'auto', contribute: 'local' },
    state: 'running',
    progress: {
      step: 'asr',
      message: 'Transcribing chapter 12 of 40',
      done: 12,
      total: 40,
      stage: 'asr',
      eta_seconds: 5400,
      cost_usd: 3.42,
      source: 'audio',
    },
    result: null,
    error: '',
    requested_by: { id: 1, username: 'admin' },
    priority: 0,
    attempts: 1,
    lease_until: '2026-10-15T10:02:00Z',
    cancel_requested: false,
    created_at: '2026-10-15T09:00:00Z',
    updated_at: '2026-10-15T10:00:00Z',
    claimed_at: '2026-10-15T09:00:05Z',
    finished_at: null,
  };

  it("lists a book's jobs with GET /admin/bridge/jobs?library_id=&path=, unwrapping jobs", async () => {
    const fetchMock = installFetch(() => ({ status: 200, body: { jobs: [job], next_before: 3 } }));
    await expect(c().bridgeJobs(1, 'Author/Series/Book 2')).resolves.toEqual([job]);
    expect(sent(fetchMock)).toMatchObject({
      url: 'https://h/api/v1/admin/bridge/jobs?library_id=1&path=Author%2FSeries%2FBook+2',
      method: 'GET',
      body: undefined,
    });
  });

  it('reads a list without jobs as []', async () => {
    installFetch(() => ({ status: 200, body: { jobs: null } }));
    await expect(c().bridgeJobs(1, 'x')).resolves.toEqual([]);
  });

  it('queues with POST /admin/bridge/jobs { kind, library_id, path, params }', async () => {
    const fetchMock = installFetch(() => ({ status: 201, body: { ...job, state: 'queued' } }));
    const body = {
      kind: 'sidecars.generate',
      library_id: 1,
      path: 'Author/Series/Book 2',
      params: { source: 'auto' as const, contribute: 'local' as const },
    };
    await expect(c().queueBridgeJob(body)).resolves.toMatchObject({ id: 12, state: 'queued' });
    expect(sent(fetchMock)).toEqual({
      url: 'https://h/api/v1/admin/bridge/jobs',
      method: 'POST',
      body,
      contentType: 'application/json',
    });
  });

  it('reads a refusal to queue by its code', async () => {
    installFetch(() => ({
      status: 409,
      body: { error: 'the bridge cannot write this library', code: 'library_not_writable' },
    }));
    const e = await c()
      .queueBridgeJob({ kind: 'sidecars.generate', library_id: 1, path: 'x' })
      .catch((err: unknown) => err);
    expect(e).toMatchObject({ name: 'ApiError', status: 409, code: 'library_not_writable' });
    expect(apiErrorKind(e)).toBe('library_not_writable');
  });

  it('cancels with POST /admin/bridge/jobs/{id}/cancel and answers the job', async () => {
    const fetchMock = installFetch(() => ({
      status: 200,
      body: { ...job, cancel_requested: true },
    }));
    await expect(c().cancelBridgeJob(12)).resolves.toMatchObject({ cancel_requested: true });
    expect(sent(fetchMock)).toEqual({
      url: 'https://h/api/v1/admin/bridge/jobs/12/cancel',
      method: 'POST',
      body: undefined,
      contentType: undefined,
    });
  });

  it('asks for the estimate with GET /admin/bridge/estimate?library_id=&path=&kind=', async () => {
    const estimate = {
      kind: 'sidecars.generate',
      library_id: 1,
      path: 'Author/Series/Book 2',
      source: 'audio',
      duration_seconds: 36000,
      asr_hours: 2.5,
      agent_cost_usd: null,
      subscription: true,
      agent_ready: true,
      figures: true,
      writable: true,
      has: {
        community: { characters: false, recaps: false },
        local: { characters: false, recaps: false },
        community_unknown: true,
      },
      earlier: [
        {
          library_id: 1,
          path: 'Author/Series/Book 1',
          title: 'Book 1',
          series_index: '1',
          asr_hours: 2.25,
          agent_cost_usd: null,
        },
      ],
      open_job: job,
    };
    const fetchMock = installFetch(() => ({ status: 200, body: estimate }));
    await expect(
      c().bridgeEstimate(1, 'Author/Series/Book 2', 'sidecars.generate'),
    ).resolves.toEqual(estimate);
    expect(sent(fetchMock)).toMatchObject({
      url: 'https://h/api/v1/admin/bridge/estimate?library_id=1&path=Author%2FSeries%2FBook+2&kind=sidecars.generate',
      method: 'GET',
    });
  });

  // Bridge 1c: a run says whether it wrote the book's description (or why not), and the
  // estimate says whether the Bridge can describe and who has a description. The player
  // queues no description of its own, but mirrors every field.
  it('passes through what Bridge 1c adds to a result and to the estimate', async () => {
    const result: SidecarsGenerateResult = {
      library_id: 1,
      path: 'Author/Series/Book 2',
      source: 'audio',
      files: ['characters.json', 'recaps.json', 'bridge.json'],
      characters: 12,
      recaps: 30,
      cost_usd: 4.2,
      work_id: '',
      description: false,
      description_error: 'the agent wrote too little',
    };
    installFetch(() => ({ status: 200, body: { jobs: [{ ...job, state: 'done', result }] } }));
    const [done] = await c().bridgeJobs(1, 'Author/Series/Book 2');
    expect(done.result).toEqual(result);
    expect((done.result as SidecarsGenerateResult).description).toBe(false);
    expect((done.result as SidecarsGenerateResult).description_error).toBe(
      'the agent wrote too little',
    );

    const estimate: BridgeEstimate = {
      kind: 'sidecars.generate',
      library_id: 1,
      path: 'Author/Series/Book 2',
      source: 'audio',
      duration_seconds: 36000,
      asr_hours: 2.5,
      agent_cost_usd: 16,
      subscription: false,
      agent_ready: true,
      can_contribute: false,
      figures: true,
      writable: true,
      can_describe: true,
      has: {
        community: { characters: false, recaps: false, description: true },
        local: { characters: true, recaps: true, description: false },
      },
      earlier: [],
    };
    installFetch(() => ({ status: 200, body: estimate }));
    const got = await c().bridgeEstimate(1, 'Author/Series/Book 2', 'sidecars.generate');
    expect(got).toEqual(estimate);
    expect(got.can_describe).toBe(true);
    expect(got.has.community.description).toBe(true);
    expect(got.has.local.description).toBe(false);
  });

  it("surfaces a non-admin's 403 as an ApiError", async () => {
    installFetch(() => ({ status: 403, body: { error: 'admin only' } }));
    await expect(c().bridgeJobs(1, 'x')).rejects.toMatchObject({ name: 'ApiError', status: 403 });
  });
});

describe('ApiClient podcasts (Bridge Phase 2d-1)', () => {
  type Answer = { status: number; body?: unknown; text?: string; headers?: Record<string, string> };

  /** A fake fetch with response headers and raw bodies (an HTML 503, a 1-byte 206). */
  function installAnswers(impl: (url: string, init: RequestInit) => Answer): jest.Mock {
    const mock = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const { status, body, text, headers = {} } = impl(String(input), init ?? {});
      const raw = text ?? (body === undefined ? '' : JSON.stringify(body));
      const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        statusText: `status ${status}`,
        headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
        text: () => Promise.resolve(raw),
      } as unknown as Response);
    });
    globalThis.fetch = mock as unknown as typeof globalThis.fetch;
    return mock;
  }

  const client = () => new ApiClient('https://h', 'tok');
  const call = (m: jest.Mock, i = 0) => ({
    url: String(m.mock.calls[i][0]),
    init: m.mock.calls[i][1] as RequestInit,
  });

  it('unwraps the shows of a podcast library', async () => {
    const show = podcastShow();
    const m = installAnswers(() => ({ status: 200, body: { shows: [show] } }));
    await expect(client().podcastShows(5)).resolves.toEqual([show]);
    expect(call(m).url).toBe('https://h/api/v1/libraries/5/podcasts');
    installAnswers(() => ({ status: 200, body: { shows: null } }));
    await expect(client().podcastShows(5)).resolves.toEqual([]);
  });

  it("asks for a show's episodes by show, order, limit and cursor", async () => {
    const page = { episodes: [podcastEpisode()], next_cursor: 'abc' };
    const m = installAnswers(() => ({ status: 200, body: page }));
    await expect(
      client().podcastEpisodes(5, {
        show: 'The Daily Show',
        order: 'oldest',
        limit: 50,
        cursor: 'xyz',
      }),
    ).resolves.toEqual(page);
    const url = new URL(call(m).url);
    expect(url.pathname).toBe('/api/v1/libraries/5/podcasts/episodes');
    expect(url.searchParams.get('show')).toBe('The Daily Show');
    expect(url.search).toContain('show=The+Daily+Show');
    expect(url.searchParams.get('order')).toBe('oldest');
    expect(url.searchParams.get('limit')).toBe('50');
    expect(url.searchParams.get('cursor')).toBe('xyz');
    // The first page sends no cursor; a last page's null cursor stays null.
    installAnswers(() => ({ status: 200, body: { episodes: null, next_cursor: null } }));
    await expect(client().podcastEpisodes(5, { show: 'S', order: 'newest' })).resolves.toEqual({
      episodes: [],
      next_cursor: null,
    });
  });

  it('reads the followed shows and requests', async () => {
    const m = installAnswers(() => ({
      status: 200,
      body: { shows: [podcastShow()], requests: [] },
    }));
    await expect(client().myPodcasts()).resolves.toEqual({ shows: [podcastShow()], requests: [] });
    expect(call(m).url).toBe('https://h/api/v1/me/podcasts');
  });

  it('follows by path with exactly {library_id, path}, both answer shapes', async () => {
    const m = installAnswers(() => ({
      status: 200,
      body: { state: 'following', show: podcastShow() },
    }));
    await expect(client().followPodcast(5, 'Daily News')).resolves.toEqual({
      state: 'following',
      show: podcastShow(),
    });
    const { url, init } = call(m);
    expect(url).toBe('https://h/api/v1/podcasts/follow');
    expect(init.method).toBe('POST');
    // Never `private` beside a path: the server refuses it.
    expect(JSON.parse(String(init.body))).toEqual({ library_id: 5, path: 'Daily News' });

    const request = {
      id: 3,
      library_id: 5,
      state: 'queued',
      feed: 'https://news.example/...',
      private: false,
      show_path: null,
      error: null,
      created_at: '2026-10-22T10:00:00Z',
      updated_at: '2026-10-22T10:00:00Z',
    };
    installAnswers(() => ({ status: 202, body: { state: 'subscribing', request } }));
    await expect(client().followPodcast(5, 'Daily News')).resolves.toEqual({
      state: 'subscribing',
      request,
    });
  });

  it('unfollows with a DELETE query and resolves undefined on 204', async () => {
    const m = installAnswers(() => ({ status: 204 }));
    await expect(client().unfollowPodcast(5, 'Daily News')).resolves.toBeUndefined();
    const { url, init } = call(m);
    expect(init.method).toBe('DELETE');
    expect(url).toBe('https://h/api/v1/podcasts/follow?library_id=5&path=Daily+News');
    expect(init.body).toBeUndefined();
  });

  it('reads the fetch status by an encoded path', async () => {
    const m = installAnswers(() => ({ status: 200, body: wire2b.status_response }));
    await expect(client().podcastFetchStatus(5, 'Daily News/Ep 1 & 2.mp3')).resolves.toEqual(
      wire2b.status_response,
    );
    const { url, init } = call(m);
    expect(init.method).toBe('GET');
    expect(url).toBe(
      'https://h/api/v1/libraries/5/podcasts/fetch?path=Daily+News%2FEp+1+%26+2.mp3',
    );
  });

  it('retries with a POST whose body is exactly {path}', async () => {
    const m = installAnswers(() => ({ status: 202, body: wire2b.status_response }));
    await expect(client().retryPodcastFetch(5, 'Daily News/E1.mp3')).resolves.toEqual(
      wire2b.status_response,
    );
    const { url, init } = call(m);
    expect(url).toBe('https://h/api/v1/libraries/5/podcasts/fetch');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ path: 'Daily News/E1.mp3' });
  });

  it('probes the stream with one byte, the token in the header and no token= in the URL', async () => {
    const m = installAnswers(() => ({
      status: 206,
      text: 'I',
      headers: { 'Content-Range': 'bytes 0-0/16493' },
    }));
    await expect(client().prepareEpisodeStream(5, 'Daily News/E1.mp3')).resolves.toBeUndefined();
    const { url, init } = call(m);
    expect(url).toBe('https://h/api/v1/libraries/5/stream?path=Daily+News%2FE1.mp3');
    expect(url).not.toContain('token=');
    expect(init.method).toBe('GET');
    expect(headerValue(init, 'Range')).toBe('bytes=0-0');
    expect(headerValue(init, 'Authorization')).toBe('Bearer tok');
  });

  it("decodes a 503 podcast_fetching into PodcastFetchPendingError, from the header and the body's wait", async () => {
    installAnswers(() => ({
      status: 503,
      body: wire2b.stream_response,
      headers: { 'Retry-After': '2' },
    }));
    const fromHeader = await client()
      .prepareEpisodeStream(5, 'Daily News/E1.mp3')
      .catch((e: unknown) => e);
    expect(fromHeader).toBeInstanceOf(PodcastFetchPendingError);
    expect(fromHeader).toBeInstanceOf(ApiError);
    expect(fromHeader).toMatchObject({
      status: 503,
      code: 'podcast_fetching',
      fetch: wire2b.stream_response.fetch,
      retryAfterSeconds: 2,
    });

    // No header (a browser that can't read it cross-origin): the status's own wait.
    installAnswers(() => ({
      status: 503,
      body: { ...wire2b.stream_response, fetch: { ...wire2b.stream_response.fetch } },
    }));
    const fromBody = await client()
      .prepareEpisodeStream(5, 'Daily News/E1.mp3')
      .catch((e: unknown) => e);
    expect(fromBody).toMatchObject({
      code: 'podcast_fetching',
      fetch: wire2b.stream_response.fetch,
      retryAfterSeconds: 2,
    });

    // Neither: two seconds.
    installAnswers(() => ({
      status: 503,
      body: {
        ...wire2b.stream_response,
        fetch: { ...wire2b.stream_response.fetch, retry_after_seconds: 'soon' },
      },
      headers: { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' },
    }));
    await expect(client().prepareEpisodeStream(5, 'E')).rejects.toMatchObject({
      retryAfterSeconds: 2,
    });
  });

  it('keeps a proxy HTML 503 a plain ApiError', async () => {
    installAnswers(() => ({ status: 503, text: '<html>Service Unavailable</html>' }));
    const e = await client()
      .prepareEpisodeStream(5, 'Daily News/E1.mp3')
      .catch((err: unknown) => err);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).not.toBeInstanceOf(PodcastFetchPendingError);
    expect((e as ApiError).status).toBe(503);
  });

  it('keeps a JSON 503 without a fetch, or with another code, a plain ApiError', async () => {
    installAnswers(() => ({ status: 503, body: { error: 'down', code: 'podcast_fetching' } }));
    await expect(client().prepareEpisodeStream(5, 'E')).rejects.not.toBeInstanceOf(
      PodcastFetchPendingError,
    );
    installAnswers(() => ({
      status: 503,
      body: { error: 'down', code: 'meta_unavailable', fetch: wire2b.ready },
    }));
    await expect(client().prepareEpisodeStream(5, 'E')).rejects.not.toBeInstanceOf(
      PodcastFetchPendingError,
    );
  });

  it('decodes a JSON route answering 503 with a fetch the same way', async () => {
    installAnswers(() => ({
      status: 503,
      body: {
        error: 'The episode could not be fetched.',
        code: 'podcast_fetch_failed',
        fetch: wire2b.failed,
      },
      headers: { 'Retry-After': '2' },
    }));
    const e = await client()
      .chapters(5, 'Daily News/E1.mp3')
      .catch((err: unknown) => err);
    expect(e).toBeInstanceOf(PodcastFetchPendingError);
    expect(e).toMatchObject({ code: 'podcast_fetch_failed', fetch: wire2b.failed });
  });

  it('tells the podcast refusals apart by code', async () => {
    installAnswers(() => ({
      status: 409,
      body: { error: 'Too many episodes are being fetched.', code: 'fetch_limit' },
    }));
    const e = await client()
      .retryPodcastFetch(5, 'E')
      .catch((err: unknown) => err);
    expect(apiErrorKind(e)).toBe('fetch_limit');
    for (const code of [
      'module_off',
      'bridge_unavailable',
      'identity_changed',
      'show_not_found',
      'kid_account',
      'demo_account',
    ]) {
      expect(apiErrorKind(new ApiError(409, 'x', code))).toBe(code);
    }
  });

  it('flags a dead token on a 401 probe', async () => {
    const onAuthError = jest.fn();
    installAnswers(() => ({ status: 401, body: { error: 'invalid or expired token' } }));
    await expect(
      new ApiClient('https://h', 'tok', 15000, onAuthError).prepareEpisodeStream(5, 'E'),
    ).rejects.toMatchObject({ status: 401 });
    expect(onAuthError).toHaveBeenCalledTimes(1);
  });
});

describe('ApiClient finding shows (Bridge Phase 2d-2)', () => {
  type Answer = { status: number; body?: unknown; text?: string; headers?: Record<string, string> };

  /** A fake fetch with response headers (case-insensitive, like `Headers.get`). */
  function installAnswers(impl: (url: string, init: RequestInit) => Answer): jest.Mock {
    const mock = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const { status, body, text, headers = {} } = impl(String(input), init ?? {});
      const raw = text ?? (body === undefined ? '' : JSON.stringify(body));
      const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        statusText: `status ${status}`,
        headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
        text: () => Promise.resolve(raw),
      } as unknown as Response);
    });
    globalThis.fetch = mock as unknown as typeof globalThis.fetch;
    return mock;
  }

  /** Answer every request with one refusal. */
  const refuse = (status: number, code: string, headers?: Record<string, string>) =>
    installAnswers(() => ({ status, body: { error: 'Server English.', code }, headers }));

  const client = () => new ApiClient('https://h', 'tok');
  const call = (m: jest.Mock, i = 0) => ({
    url: new URL(String(m.mock.calls[i][0])),
    init: m.mock.calls[i][1] as RequestInit,
  });
  const failure = (p: Promise<unknown>) =>
    p.then(
      () => {
        throw new Error('resolved');
      },
      (e: unknown) => e as ApiError,
    );

  it('reads the providers', async () => {
    const m = installAnswers(() => ({ status: 200, body: golden2c3.wire.providers }));
    await expect(client().podcastDiscoveryProviders()).resolves.toEqual(golden2c3.wire.providers);
    expect(call(m).url.toString()).toBe('https://h/api/v1/podcasts/discovery/providers');
    expect(headerValue(call(m).init, 'Authorization')).toBe('Bearer tok');
  });

  it('searches iTunes with the country and keeps provider ids as strings', async () => {
    const m = installAnswers(() => ({
      status: 200,
      text: goldenText('providers/itunes-normalized.json'),
    }));
    const r = await client().searchPodcastDirectory({
      q: 'fixture show',
      provider: 'itunes',
      country: 'GB',
      limit: 20,
    });
    expect(r).toEqual(golden2c3.itunes);
    expect(r.results[1].provider_ids.itunes).toBe('9007199254740993');
    const { url } = call(m);
    expect(url.pathname).toBe('/api/v1/podcasts/discovery/search');
    expect([...url.searchParams.entries()]).toEqual([
      ['q', 'fixture show'],
      ['provider', 'itunes'],
      ['limit', '20'],
      ['country', 'GB'],
    ]);
  });

  it('never sends a country to Podcast Index', async () => {
    const m = installAnswers(() => ({
      status: 200,
      text: goldenText('providers/podcast-index-normalized.json'),
    }));
    const r = await client().searchPodcastDirectory({
      q: 'fixture show',
      provider: 'podcast_index',
      country: 'GB',
    });
    expect(r).toEqual(golden2c3.podcastIndex);
    expect(r.country).toBeNull();
    expect(call(m).url.searchParams.has('country')).toBe(false);
    expect(call(m).url.searchParams.get('provider')).toBe('podcast_index');
  });

  it('tells the search refusals apart, with Retry-After when it reads', async () => {
    const unavailable = goldenError('provider_unavailable');
    installAnswers(() => ({ status: unavailable.http_status, body: unavailable.body }));
    const e409 = await failure(
      client().searchPodcastDirectory({ q: 'ab', provider: 'podcast_index' }),
    );
    expect(e409.status).toBe(409);
    expect(apiErrorKind(e409)).toBe('provider_unavailable');

    const limited = goldenError('discovery_rate_limited');
    installAnswers(() => ({
      status: limited.http_status,
      body: limited.body,
      headers: limited.headers,
    }));
    const e429 = await failure(client().searchPodcastDirectory({ q: 'ab', provider: 'itunes' }));
    expect(apiErrorKind(e429)).toBe('discovery_rate_limited');
    expect(e429.retryAfterSeconds).toBe(6);

    // A header the browser can't read (cross-origin) or a date reads as absent.
    installAnswers(() => ({ status: 429, body: limited.body }));
    const noHeader = await failure(
      client().searchPodcastDirectory({ q: 'ab', provider: 'itunes' }),
    );
    expect(noHeader.retryAfterSeconds).toBeUndefined();
    refuse(429, 'provider_rate_limited', { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' });
    const dated = await failure(client().searchPodcastDirectory({ q: 'ab', provider: 'itunes' }));
    expect(apiErrorKind(dated)).toBe('provider_rate_limited');
    expect(dated.retryAfterSeconds).toBeUndefined();

    refuse(503, 'discovery_busy', { 'Retry-After': '1' });
    const busy = await failure(client().searchPodcastDirectory({ q: 'ab', provider: 'itunes' }));
    expect(apiErrorKind(busy)).toBe('discovery_busy');
    expect(busy.retryAfterSeconds).toBe(1);

    for (const [status, code] of [
      [404, 'discovery_off'],
      [404, 'module_off'],
      [403, 'kid_account'],
      [403, 'demo_account'],
      [403, 'no_library_access'],
      [400, 'invalid_query'],
      [400, 'invalid_country'],
      [504, 'discovery_timeout'],
      [502, 'provider_rejected'],
      [502, 'discovery_unavailable'],
    ] as const) {
      refuse(status, code);
      const e = await failure(client().searchPodcastDirectory({ q: 'ab', provider: 'itunes' }));
      expect([e.status, apiErrorKind(e)]).toEqual([status, code]);
    }
  });

  it('rebuilds a result artwork URL from its id with the media token', () => {
    const rel = golden2c3.itunes.results[0].artwork_url;
    const url = new URL(client().discoveryArtworkUrl(rel)!);
    expect(url.origin + url.pathname).toBe('https://h/api/v1/podcasts/discovery/artwork');
    expect([...url.searchParams.entries()]).toEqual([
      ['id', '4745a0c5c9b5a0a81f9d9396ab9abcc27c981462c6fdcbb7ab8f117de612d0e6'],
      ['token', 'tok'],
    ]);
    expect(new ApiClient('https://h').discoveryArtworkUrl(rel)).toBe(
      'https://h/api/v1/podcasts/discovery/artwork?id=4745a0c5c9b5a0a81f9d9396ab9abcc27c981462c6fdcbb7ab8f117de612d0e6',
    );
    const id = 'a'.repeat(64);
    for (const bad of [
      null,
      undefined,
      '',
      `https://evil.example/api/v1/podcasts/discovery/artwork?id=${id}`,
      `/api/v1/podcasts/discovery/artwork?id=${'A'.repeat(64)}`,
      `/api/v1/podcasts/discovery/artwork?id=${id.slice(1)}`,
      `/api/v1/podcasts/discovery/artwork?id=${id}&x=1`,
      `/api/v1/libraries/1/cover?id=${id}`,
    ]) {
      expect(client().discoveryArtworkUrl(bad)).toBeNull();
    }
  });

  it('follows by address with exactly {library_id, feed_url}, private only when asked', async () => {
    const m = installAnswers(() => ({
      status: 200,
      body: { state: 'following', show: podcastShow() },
    }));
    await expect(
      client().followPodcastByUrl(5, 'https://feeds.example.org/one.xml'),
    ).resolves.toEqual({
      state: 'following',
      show: podcastShow(),
    });
    expect(call(m).url.toString()).toBe('https://h/api/v1/podcasts/follow');
    expect(call(m).init.method).toBe('POST');
    expect(JSON.parse(call(m).init.body as string)).toEqual({
      library_id: 5,
      feed_url: 'https://feeds.example.org/one.xml',
    });
    await client().followPodcastByUrl(5, 'https://f/x', { private: false });
    expect(JSON.parse(call(m, 1).init.body as string)).toEqual({
      library_id: 5,
      feed_url: 'https://f/x',
    });
    await client().followPodcastByUrl(5, 'https://f/x', { private: true });
    expect(JSON.parse(call(m, 2).init.body as string)).toEqual({
      library_id: 5,
      feed_url: 'https://f/x',
      private: true,
    });
  });

  it('decodes a 202 subscribing and the follow-by-address refusals', async () => {
    const request = {
      id: 81,
      library_id: 5,
      state: 'queued',
      feed: 'https://feeds.example.org/...',
      private: false,
      show_path: null,
      error: null,
      created_at: '2026-10-20T08:00:00Z',
      updated_at: '2026-10-20T08:00:00Z',
    };
    installAnswers(() => ({ status: 202, body: { state: 'subscribing', request } }));
    await expect(client().followPodcastByUrl(5, 'https://f/x')).resolves.toEqual({
      state: 'subscribing',
      request,
    });
    for (const [status, code] of [
      [400, 'invalid_feed_url'],
      [409, 'privacy_conflict'],
      [409, 'bridge_unavailable'],
      [409, 'not_podcast_library'],
      [409, 'library_not_writable'],
      [429, 'too_many_requests'],
      [403, 'no_library_access'],
    ] as const) {
      refuse(status, code);
      const e = await failure(client().followPodcastByUrl(5, 'https://f/x'));
      expect([e.status, apiErrorKind(e)]).toEqual([status, code]);
    }
  });

  it('asks a show to check with exactly {library_id, path}', async () => {
    const m = installAnswers(() => ({
      status: 202,
      body: { request: { id: 9, state: 'queued' } },
    }));
    await expect(client().checkPodcast(5, 'Daily News')).resolves.toEqual({
      request: { id: 9, state: 'queued' },
    });
    expect(call(m).url.toString()).toBe('https://h/api/v1/podcasts/check');
    expect(JSON.parse(call(m).init.body as string)).toEqual({ library_id: 5, path: 'Daily News' });
    refuse(429, 'checked_recently');
    expect(apiErrorKind(await failure(client().checkPodcast(5, 'S')))).toBe('checked_recently');
    refuse(404, 'show_not_found');
    expect(apiErrorKind(await failure(client().checkPodcast(5, 'S')))).toBe('show_not_found');
  });

  it('uploads OPML as the raw body with text/x-opml and decodes the rows', async () => {
    const m = installAnswers(() => ({
      status: 200,
      text: goldenText('opml/duplicates-private-expected.json'),
    }));
    const bytes = goldenBytes('opml/queue-cap.opml');
    await expect(client().importOpml(7, bytes)).resolves.toEqual(golden2c3.importRows);
    const { url, init } = call(m);
    expect(url.toString()).toBe('https://h/api/v1/podcasts/opml/import?library_id=7');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(bytes);
    expect(headerValue(init, 'Content-Type')).toBe('text/x-opml');
    expect(headerValue(init, 'Authorization')).toBe('Bearer tok');
    expect(headerValue(init, 'Content-Encoding')).toBeUndefined();
    // A Blob (the web picker's File) goes as it is too, whatever type it carries.
    const blob = new Blob(['<opml/>'], { type: 'application/octet-stream' });
    await client().importOpml(7, blob);
    expect(call(m, 1).init.body).toBe(blob);
    expect(headerValue(call(m, 1).init, 'Content-Type')).toBe('text/x-opml');
  });

  it('keeps a recently failed row (server v2.4.0) as the server sent it', async () => {
    const row = {
      outline_index: 2,
      status: 'error',
      feed: 'https://dead.example/...',
      private: false,
      path: null,
      request_id: 41,
      duplicate_of: null,
      error: { code: 'recently_failed', message: 'This feed could not be followed recently.' },
    };
    installAnswers(() => ({ status: 200, body: { library_id: 7, rows: [row] } }));
    await expect(client().importOpml(7, new Uint8Array([1]))).resolves.toEqual({
      library_id: 7,
      rows: [row],
    });
  });

  it('gives an OPML upload 45 s before it times out', async () => {
    jest.useFakeTimers();
    try {
      globalThis.fetch = jest.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            );
          }),
      ) as unknown as typeof globalThis.fetch;
      const p = failure(client().importOpml(7, new Uint8Array([1])));
      jest.advanceTimersByTime(44_000);
      let settled = false;
      void p.then(() => (settled = true));
      await Promise.resolve();
      expect(settled).toBe(false);
      jest.advanceTimersByTime(1_000);
      expect(await p).toMatchObject({ name: 'TimeoutError', timeoutMs: 45_000 });
    } finally {
      jest.useRealTimers();
    }
  });

  it('tells the import refusals apart, with Retry-After', async () => {
    const invalid = goldenError('invalid_opml');
    installAnswers(() => ({ status: invalid.http_status, body: invalid.body }));
    const e400 = await failure(client().importOpml(7, new Uint8Array()));
    expect([e400.status, apiErrorKind(e400)]).toEqual([400, 'invalid_opml']);
    for (const [status, code] of [
      [413, 'opml_limit'],
      [415, 'unsupported_opml_type'],
      [404, 'module_off'],
      [409, 'not_podcast_library'],
    ] as const) {
      refuse(status, code);
      const e = await failure(client().importOpml(7, new Uint8Array()));
      expect([e.status, apiErrorKind(e)]).toEqual([status, code]);
    }
    refuse(429, 'opml_rate_limited', { 'Retry-After': '29' });
    const limited = await failure(client().importOpml(7, new Uint8Array()));
    expect([apiErrorKind(limited), limited.retryAfterSeconds]).toEqual(['opml_rate_limited', 29]);
    refuse(503, 'opml_busy', { 'Retry-After': '1' });
    const busy = await failure(client().importOpml(7, new Uint8Array()));
    expect([apiErrorKind(busy), busy.retryAfterSeconds]).toEqual(['opml_busy', 1]);
  });

  it('exports with the Authorization header and reads the X-OPML counts in any case', async () => {
    // Go writes the canonical `X-Opml-*` spelling; `Headers.get` matches any case.
    const canonical = Object.fromEntries(
      Object.entries(golden2c3.exportHeaders).map(([k, v]) => [
        k.replace(/^X-OPML-/, 'X-Opml-'),
        v,
      ]),
    );
    const m = installAnswers(() => ({
      status: 200,
      text: goldenText('opml/export-expected.opml'),
      headers: canonical,
    }));
    await expect(client().exportOpml()).resolves.toEqual({
      text: goldenText('opml/export-expected.opml'),
      exported: 1,
      omittedPrivate: 1,
      omittedUnavailable: 1,
    });
    const { url, init } = call(m);
    expect(url.toString()).toBe('https://h/api/v1/podcasts/opml/export');
    expect(url.searchParams.has('token')).toBe(false);
    expect(init.method).toBe('GET');
    expect(headerValue(init, 'Authorization')).toBe('Bearer tok');
  });

  it('reads missing or odd export counts as null', async () => {
    installAnswers(() => ({
      status: 200,
      text: '<opml/>',
      headers: { 'X-OPML-Exported': 'lots', 'X-OPML-Omitted-Private': '-1' },
    }));
    await expect(client().exportOpml()).resolves.toEqual({
      text: '<opml/>',
      exported: null,
      omittedPrivate: null,
      omittedUnavailable: null,
    });
  });

  it('tells the export refusals apart', async () => {
    refuse(413, 'opml_export_limit');
    expect(apiErrorKind(await failure(client().exportOpml()))).toBe('opml_export_limit');
    refuse(429, 'opml_rate_limited', { 'Retry-After': '10' });
    const limited = await failure(client().exportOpml());
    expect([apiErrorKind(limited), limited.retryAfterSeconds]).toEqual(['opml_rate_limited', 10]);
    refuse(403, 'demo_account');
    expect(apiErrorKind(await failure(client().exportOpml()))).toBe('demo_account');
  });
});

describe('reading (capability ebooks, Bridge Phase 3b)', () => {
  const client = () => new ApiClient('https://h', 'tok');
  const call = (m: jest.Mock) => {
    const [input, init] = m.mock.calls[0] as [string, RequestInit];
    return { url: new URL(input), init };
  };

  it('fetches the ebook bytes by the BOOK path, with the Authorization header and no token in the URL', async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 3, 4]).buffer;
    const m = jest.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(bytes),
        text: () => Promise.resolve(''),
      } as unknown as Response),
    );
    globalThis.fetch = m as unknown as typeof globalThis.fetch;
    await expect(client().ebook(1, 'Author/Book')).resolves.toBe(bytes);
    const { url, init } = call(m);
    expect(url.pathname).toBe('/api/v1/libraries/1/ebook');
    expect(url.searchParams.get('path')).toBe('Author/Book');
    expect(url.searchParams.has('token')).toBe(false);
    expect(init.method).toBe('GET');
    expect(headerValue(init, 'Authorization')).toBe('Bearer tok');
  });

  it('names the ebook request for a download it does not make: the credential in a header, never the URL', () => {
    const { url, headers } = client().ebookRequest(1, 'Author/Book');
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/api/v1/libraries/1/ebook');
    expect(parsed.searchParams.get('path')).toBe('Author/Book');
    expect(parsed.searchParams.has('token')).toBe(false);
    expect(headers.Authorization).toBe('Bearer tok');
  });

  it('throws the server refusal for an ebook it does not serve', async () => {
    installFetch(() => ({ status: 404, body: { error: 'no ebook' } }));
    await expect(client().ebook(1, 'Author/Book')).rejects.toMatchObject({ status: 404 });
  });

  /** A 200 whose body the test feeds, failing when the request is aborted, as a real
   * download's body does; `announced` is its Content-Length. */
  function installDownload(announced?: number) {
    let feed!: ReadableStreamDefaultController<Uint8Array>;
    globalThis.fetch = jest.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({ start: (c) => void (feed = c) });
      init?.signal?.addEventListener('abort', () =>
        feed.error(Object.assign(new Error('aborted'), { name: 'AbortError' })),
      );
      const headers = new Headers(
        announced === undefined ? {} : { 'Content-Length': String(announced) },
      );
      return Promise.resolve({ ok: true, status: 200, headers, body } as unknown as Response);
    }) as unknown as typeof globalThis.fetch;
    return {
      piece: (...bytes: number[]) => feed.enqueue(new Uint8Array(bytes)),
      end: () => feed.close(),
    };
  }

  it('lets a slow ebook download run past the timeout while it keeps arriving', async () => {
    jest.useFakeTimers();
    try {
      const download = installDownload(3);
      const book = client().ebook(1, 'Author/Book');
      for (const byte of [1, 2, 3]) {
        await jest.advanceTimersByTimeAsync(100_000);
        download.piece(byte);
      }
      download.end();
      expect([...new Uint8Array(await book)]).toEqual([1, 2, 3]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('reads the whole ebook, whatever size the server announced', async () => {
    for (const announced of [undefined, 2, 5]) {
      const download = installDownload(announced);
      const book = client().ebook(1, 'Author/Book');
      download.piece(1, 2);
      download.piece(3);
      download.end();
      const bytes = await book;
      expect([...new Uint8Array(bytes)]).toEqual([1, 2, 3]);
      expect(bytes.byteLength).toBe(3);
    }
  });

  it('fails an ebook download that stalls as a timeout', async () => {
    jest.useFakeTimers();
    try {
      const download = installDownload();
      const book = client()
        .ebook(1, 'Author/Book')
        .catch((e: unknown) => e);
      await jest.advanceTimersByTimeAsync(100_000);
      download.piece(1);
      await jest.advanceTimersByTimeAsync(120_000);
      expect(await book).toMatchObject({ name: 'TimeoutError', timeoutMs: 120_000 });
    } finally {
      jest.useRealTimers();
    }
  });

  it('reads the place, null when there is none', async () => {
    const row = {
      library_id: 1,
      path: 'Author/Book',
      cfi: 'epubcfi(/6/4!/4/2/1:0)',
      progression: 0.42,
      version: 3,
      device_id: 'd1',
      device_name: 'Pixel 8',
      updated_at: '2026-10-25T10:00:00Z',
    };
    const m = installFetch(() => ({ status: 200, body: { reading_progress: row } }));
    await expect(client().readingProgress(1, 'Author/Book')).resolves.toEqual(row);
    const { url } = call(m);
    expect(url.pathname).toBe('/api/v1/libraries/1/reading-progress');
    expect(url.searchParams.get('path')).toBe('Author/Book');
    installFetch(() => ({ status: 200, body: { reading_progress: null } }));
    await expect(client().readingProgress(1, 'Author/Book')).resolves.toBeNull();
  });

  it('saves the place with its base_version and returns the kept row and other_place', async () => {
    const answer = {
      reading_progress: {
        library_id: 1,
        path: 'Author/Book',
        cfi: 'epubcfi(/6/10!/4/2/1:0)',
        progression: 0.6,
        version: 7,
        device_id: 'other',
        device_name: 'Pixel 8',
        updated_at: '2026-10-25T10:00:00Z',
      },
      other_place: {
        cfi: 'epubcfi(/6/4!/4/2/1:0)',
        progression: 0.3,
        device_id: 'me',
        device_name: '',
        updated_at: '2026-10-25T11:00:00Z',
      },
    };
    const m = installFetch(() => ({ status: 200, body: answer }));
    const input = {
      cfi: 'epubcfi(/6/4!/4/2/1:0)',
      progression: 0.3,
      device_id: 'me',
      updated_at: '2026-10-25T11:00:00Z',
      base_version: 5,
    };
    await expect(client().saveReadingProgress(1, 'Author/Book', input)).resolves.toEqual(answer);
    const { url, init } = call(m);
    expect(init.method).toBe('PUT');
    expect(url.pathname).toBe('/api/v1/libraries/1/reading-progress');
    expect(url.searchParams.get('path')).toBe('Author/Book');
    expect(JSON.parse(String(init.body))).toEqual(input);
  });
});
