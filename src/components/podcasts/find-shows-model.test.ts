import { ApiError } from '@/api/client';
import i18n from '@/i18n';
import type { OpmlImportRow, PodcastRequest } from '@/api/types';
import { golden2c3 } from '@/testing/podcast-fixtures-2c3';

import { artworkRetryDelay } from './artwork-retry';
import {
  availableSections,
  checkErrorKey,
  cleanSearchText,
  exportErrorKey,
  failedRows,
  feedAddressProblem,
  followByUrlErrorKey,
  importFailureKey,
  importProgress,
  importRowKey,
  importRowReasonKey,
  liveImportRows,
  requestEnd,
  requestStateKey,
  resolveSection,
  searchErrorCopy,
} from './find-shows-model';
import { requestReasonKey } from './podcast-model';

const refusal = (status: number, code?: string, retryAfter?: number) =>
  new ApiError(status, 'Server English.', code, retryAfter);

describe('sections', () => {
  it('offers Search and Import only with their flags, a feed address always', () => {
    expect(availableSections({ discovery: true, opml: true })).toEqual([
      'search',
      'address',
      'import',
    ]);
    expect(availableSections({ discovery: undefined, opml: false })).toEqual(['address']);
    expect(availableSections({ discovery: false, opml: true })).toEqual(['address', 'import']);
  });

  it("takes the link's section when offered, else the first", () => {
    expect(resolveSection('import', ['search', 'address', 'import'])).toBe('import');
    expect(resolveSection('import', ['address'])).toBe('address');
    expect(resolveSection(null, ['search', 'address'])).toBe('search');
  });
});

describe('search text and feed addresses', () => {
  it('cleans the search text as the server does', () => {
    expect(cleanSearchText('  fixture \n\t  show ')).toBe('fixture show');
    expect(cleanSearchText('A  B')).toBe('A B');
  });

  it('checks a feed address locally', () => {
    expect(feedAddressProblem('  ')).toBe('empty');
    expect(feedAddressProblem('feeds.example.org/one.xml')).toBe('notHttp');
    expect(feedAddressProblem('ftp://feeds.example.org/one.xml')).toBe('notHttp');
    expect(feedAddressProblem('https://')).toBe('notHttp');
    expect(feedAddressProblem('https://feeds.example.org/one xml')).toBe('notHttp');
    expect(feedAddressProblem(` ${golden2c3.itunes.results[0].feed_url} `)).toBeNull();
    expect(feedAddressProblem('HTTP://user:secret@feeds.example.org/p?token=1')).toBeNull();
    const long = `https://f.example/${'a'.repeat(2048 - 18)}`;
    expect(new TextEncoder().encode(long).length).toBe(2048);
    expect(feedAddressProblem(long)).toBeNull();
    expect(feedAddressProblem(`${long}a`)).toBe('tooLong');
    // Bytes, not characters: 1,016 two-byte letters plus the 18 of the prefix.
    expect(feedAddressProblem(`https://f.example/${'é'.repeat(1016)}`)).toBe('tooLong');
  });
});

describe('refusals in the listener words', () => {
  const t = i18n.t.bind(i18n);

  it('says each search refusal, with the wait when the server gave one', () => {
    expect(searchErrorCopy(refusal(429, 'discovery_rate_limited', 6))).toEqual({
      key: 'podcasts.find.searchError.rateLimitedWait',
      seconds: 6,
    });
    expect(searchErrorCopy(refusal(429, 'discovery_rate_limited'))).toEqual({
      key: 'podcasts.find.searchError.rateLimited',
    });
    expect(searchErrorCopy(refusal(429, 'provider_rate_limited', 2.5))).toEqual({
      key: 'podcasts.find.searchError.providerBusyWait',
      seconds: 3,
    });
    const cases: [ApiError | Error, string][] = [
      [refusal(503, 'discovery_busy', 1), 'busy'],
      [refusal(504, 'discovery_timeout'), 'timeout'],
      [refusal(502, 'provider_rejected'), 'rejected'],
      [refusal(502, 'discovery_unavailable'), 'unavailable'],
      [refusal(409, 'provider_unavailable'), 'providerUnavailable'],
      [refusal(404, 'discovery_off'), 'off'],
      [refusal(400, 'invalid_query'), 'invalidQuery'],
      [refusal(400, 'invalid_country'), 'invalidCountry'],
      [refusal(500), 'other'],
      [new Error('offline'), 'other'],
    ];
    for (const [e, key] of cases) {
      expect(searchErrorCopy(e).key).toBe(`podcasts.find.searchError.${key}`);
    }
    expect(searchErrorCopy(refusal(404, 'module_off')).key).toBe('podcasts.find.refusal.moduleOff');
    expect(searchErrorCopy(refusal(403, 'kid_account')).key).toBe('podcasts.find.refusal.kid');
    expect(searchErrorCopy(refusal(403, 'demo_account')).key).toBe('podcasts.find.refusal.demo');
    // A search refused for the library is about searching, not adding (R-27).
    expect(searchErrorCopy(refusal(403, 'no_library_access')).key).toBe(
      'podcasts.find.searchError.noAccess',
    );
    expect(t('podcasts.find.searchError.rateLimitedWait', { seconds: 6 })).toBe(
      "You've searched a lot just now. Try again in 6 s.",
    );
  });

  it('says each follow-by-address refusal', () => {
    const cases: [string, string][] = [
      ['invalid_feed_url', 'followError.invalidFeedUrl'],
      ['privacy_conflict', 'followError.privacyConflict'],
      ['bridge_unavailable', 'followError.cantAddNow'],
      ['library_not_writable', 'followError.notWritable'],
      ['too_many_requests', 'followError.tooMany'],
      ['no_library_access', 'refusal.noAccess'],
      ['not_podcast_library', 'refusal.notPodcastLibrary'],
      ['module_off', 'refusal.moduleOff'],
      ['kid_account', 'refusal.kid'],
      ['demo_account', 'refusal.demo'],
      ['invalid_request', 'followError.other'],
    ];
    for (const [code, key] of cases) {
      expect(followByUrlErrorKey(refusal(400, code))).toBe(`podcasts.find.${key}`);
    }
  });

  it('says why an import failed', () => {
    expect(importFailureKey('invalid_opml')).toBe('podcasts.import.fail.notOpml');
    expect(importFailureKey('unsupported_opml_type')).toBe('podcasts.import.fail.notOpml');
    expect(importFailureKey('opml_limit')).toBe('podcasts.import.fail.tooLarge');
    expect(importFailureKey('module_off')).toBe('podcasts.find.refusal.moduleOff');
    expect(importFailureKey('no_library_access')).toBe('podcasts.find.refusal.noAccess');
    expect(importFailureKey(null)).toBe('podcasts.import.fail.other');
    expect(importFailureKey('library_not_found')).toBe('podcasts.import.fail.other');
  });

  it('says a refused export and check', () => {
    expect(exportErrorKey(refusal(413, 'opml_export_limit'))).toBe('podcasts.export.error.tooMany');
    expect(exportErrorKey(refusal(429, 'opml_rate_limited', 9))).toBe('podcasts.export.error.busy');
    expect(exportErrorKey(refusal(503, 'opml_busy', 1))).toBe('podcasts.export.error.busy');
    expect(exportErrorKey(new Error('x'))).toBe('podcasts.export.error.other');
    expect(checkErrorKey(refusal(429, 'checked_recently'))).toBe('podcasts.check.recently');
    expect(checkErrorKey(refusal(409, 'bridge_unavailable'))).toBe('podcasts.check.cantNow');
    expect(checkErrorKey(refusal(404, 'show_not_found'))).toBe('podcasts.follow.errorGone');
    expect(checkErrorKey(refusal(404, 'module_off'))).toBe('podcasts.find.refusal.moduleOff');
    expect(checkErrorKey(refusal(500))).toBe('podcasts.check.failed');
  });

  it('never shows the server English or names the Bridge', () => {
    const copy = [
      ...['discovery_busy', 'provider_rejected', 'bridge_unavailable', 'privacy_conflict'].map(
        (code) => t(searchErrorCopy(refusal(409, code)).key),
      ),
      t(followByUrlErrorKey(refusal(409, 'bridge_unavailable'))),
      t(checkErrorKey(refusal(409, 'bridge_unavailable'))),
    ];
    for (const s of copy) {
      expect(s).not.toMatch(/Server English|bridge/i);
    }
  });
});

describe('import rows and requests', () => {
  it('words each row of the import golden', () => {
    expect(golden2c3.importRows.rows.map(importRowKey)).toEqual([
      'podcasts.import.row.alreadyFollowing',
      'podcasts.import.row.duplicate',
      'podcasts.import.row.alreadyFollowing',
      'podcasts.import.row.queued',
      'podcasts.import.row.invalid',
      'podcasts.import.row.invalid',
    ]);
    for (const [status, key] of [
      ['followed', 'followed'],
      ['already_queued', 'queued'],
      ['limited', 'limited'],
      ['unavailable', 'unavailable'],
      ['error', 'error'],
      ['something_new', 'error'],
    ]) {
      expect(importRowKey({ status })).toBe(`podcasts.import.row.${key}`);
    }
  });

  it('counts the rows following or on their way, leaving out duplicates and invalid ones', () => {
    expect(importProgress(golden2c3.importRows.rows)).toEqual({ settled: 3, total: 3 });
    expect(
      importProgress([
        { ...golden2c3.importRows.rows[0], status: 'limited' },
        golden2c3.importRows.rows[3],
      ]),
    ).toEqual({ settled: 1, total: 2 });
  });

  it('words a request state', () => {
    expect(requestStateKey({ state: 'queued' })).toBe('podcasts.requests.state.waiting');
    expect(requestStateKey({ state: 'needs_attention' })).toBe('podcasts.requests.state.waiting');
    expect(requestStateKey({ state: 'running' })).toBe('podcasts.requests.state.adding');
    expect(requestStateKey({ state: 'claimed' })).toBe('podcasts.requests.state.adding');
    expect(requestStateKey({ state: 'done' })).toBe('podcasts.requests.state.done');
    expect(requestStateKey({ state: 'cancelled' })).toBe('podcasts.requests.state.cancelled');
    expect(requestStateKey({ state: 'failed' })).toBe('podcasts.requests.state.failed');
  });

  it('says why a request failed', () => {
    for (const [code, key] of [
      ['dns', 'unreachable'],
      ['timeout', 'unreachable'],
      ['tls', 'unreachable'],
      ['network', 'unreachable'],
      ['not_a_feed', 'notAFeed'],
      ['not_a_podcast', 'notAFeed'],
      ['gone', 'gone'],
      // A first follow's 404 is an address with nothing there, never a feed that left
      // (BRIDGE-17); the feed's own refusals and errors in words (BRIDGE-06).
      ['http_404', 'notFound'],
      ['http_401', 'denied'],
      ['http_403', 'denied'],
      ['http_500', 'feedError'],
      ['http_429', 'feedError'],
      ['blocked_address', 'localAddress'],
      ['too_large', 'tooLarge'],
      ['request_expired', 'followAgain'],
      ['feed_secret_missing', 'followAgain'],
      ['bridge_lost', 'other'],
      [null, 'other'],
    ] as const) {
      expect(requestReasonKey(code)).toBe(`podcasts.requests.reason.${key}`);
    }
  });
});

describe('follow requests read live', () => {
  const req = (r: Partial<PodcastRequest>) => r as PodcastRequest;
  const requests = [
    req({ id: 1, state: 'running', library_id: 7, show_path: null }),
    req({ id: 2, state: 'done', library_id: 7, show_path: 'Daily News' }),
    req({ id: 3, state: 'failed', library_id: 7, show_path: null }),
  ];

  it('says how a request ended: nothing while open or not read yet', () => {
    expect(requestEnd(requests, 1)).toBeNull();
    expect(requestEnd(undefined, 2)).toBeNull();
    expect(requestEnd(requests, null)).toBeNull();
    expect(requestEnd(requests, 2)).toEqual({
      kind: 'following',
      libraryId: 7,
      path: 'Daily News',
    });
    expect(requestEnd(requests, 3)).toEqual({ kind: 'failed', error: undefined });
  });

  it('tells a cancelled request, and one the list no longer holds, from a failed one (R-24)', () => {
    const more = [
      ...requests,
      req({ id: 4, state: 'cancelled', library_id: 7, show_path: null }),
      req({
        id: 5,
        state: 'failed',
        library_id: 7,
        show_path: null,
        error: { code: 'http_404', message: '' },
      }),
    ];
    expect(requestEnd(more, 4)).toEqual({ kind: 'cancelled' });
    expect(requestEnd(more, 5)).toEqual({
      kind: 'failed',
      error: { code: 'http_404', message: '' },
    });
    expect(requestEnd(more, 9)).toEqual({ kind: 'unknown' });
  });

  it("reads each queued import row's request, leaving the others as they are", () => {
    const row = (i: number, o: Partial<OpmlImportRow>) =>
      ({
        outline_index: i,
        status: 'queued',
        feed: 'https://a.example/...',
        private: false,
        path: null,
        request_id: null,
        duplicate_of: null,
        error: null,
        ...o,
      }) as OpmlImportRow;
    const rows = [
      row(1, { request_id: 1 }),
      row(2, { status: 'already_queued', request_id: 2 }),
      row(3, { request_id: 3 }),
      row(4, { status: 'unavailable', request_id: 3 }),
    ];
    expect(liveImportRows(rows, requests).map((r) => [r.status, r.path])).toEqual([
      ['queued', null],
      ['followed', 'Daily News'],
      ['error', null],
      ['unavailable', null],
    ]);
  });

  it("ends a queued row cancelled with its request, and keeps one whose request isn't listed", () => {
    const row = (i: number, o: Partial<OpmlImportRow>) =>
      ({
        outline_index: i,
        status: 'queued',
        feed: 'https://a.example/...',
        private: false,
        path: null,
        request_id: null,
        duplicate_of: null,
        error: null,
        ...o,
      }) as OpmlImportRow;
    const listed = [
      req({ id: 4, state: 'cancelled', library_id: 7, show_path: null }),
      req({
        id: 5,
        state: 'failed',
        library_id: 7,
        show_path: null,
        error: { code: 'not_a_feed', message: '' },
      }),
    ];
    const live = liveImportRows(
      [row(1, { request_id: 4 }), row(2, { request_id: 5 }), row(3, { request_id: 9 })],
      listed,
    );
    expect(live.map((r) => r.status)).toEqual(['cancelled', 'error', 'queued']);
    // The failed row carries its request's reason, for the row's line.
    expect(live[1].error).toMatchObject({ code: 'not_a_feed' });
  });
});

describe('an import row that could not be added (BRIDGE-01)', () => {
  const row = (o: Partial<OpmlImportRow>) =>
    ({ status: 'error', request_id: null, error: null, ...o }) as OpmlImportRow;
  const failed = {
    id: 8,
    state: 'failed',
    library_id: 7,
    show_path: null,
    error: { code: 'http_404', message: '' },
  } as PodcastRequest;

  it("says why: its request's own reason when the list holds it", () => {
    expect(
      importRowReasonKey(row({ request_id: 8, error: { code: 'recently_failed', message: '' } }), [
        failed,
      ]),
    ).toBe('podcasts.requests.reason.notFound');
  });

  it("else the row's own code, in words", () => {
    const key = (code: string) =>
      importRowReasonKey(row({ request_id: 8, error: { code, message: '' } }), []);
    expect(key('recently_failed')).toBe('podcasts.import.reason.recentlyFailed');
    expect(key('privacy_conflict')).toBe('podcasts.find.followError.privacyConflict');
    expect(key('no_library_access')).toBe('podcasts.find.refusal.noAccess');
    expect(key('dns')).toBe('podcasts.requests.reason.unreachable');
    expect(importRowReasonKey(row({}), undefined)).toBeNull();
  });

  it('gives no reason for a row that was added, and counts the failed ones', () => {
    expect(importRowReasonKey(row({ status: 'followed' }), [failed])).toBeNull();
    expect(importRowKey({ status: 'cancelled' })).toBe('podcasts.import.row.cancelled');
    expect(
      failedRows([
        { status: 'error' },
        { status: 'followed' },
        { status: 'error' },
        { status: 'cancelled' },
      ]),
    ).toBe(2);
  });
});

describe('artworkRetryDelay', () => {
  it('tries again after 3 s, 10 s and 30 s, then stops (four tries)', () => {
    expect(artworkRetryDelay(0)).toBeNull();
    expect([1, 2, 3].map(artworkRetryDelay)).toEqual([3_000, 10_000, 30_000]);
    expect(artworkRetryDelay(4)).toBeNull();
  });
});
