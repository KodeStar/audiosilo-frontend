import { ApiError } from '@/api/client';
import en from '@/i18n/locales/en.json';
import { ADMIN } from '@/testing/bridge-fixtures';
import { librivoxJob, librivoxServer } from '@/testing/librivox-fixtures';

import {
  addRefusalKey,
  blocksAdd,
  fetchCode,
  fetchView,
  librivoxAccess,
  mayAddLibrivox,
  namesLine,
  readErrorKey,
  rowState,
} from './librivox-model';

/** Whether `key` (dotted) is a string in the English catalog. */
const hasKey = (key: string) =>
  typeof key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], en) ===
  'string';

describe('librivoxAccess / mayAddLibrivox (who sees Find on LibriVox)', () => {
  it('lets an admin in where the Bridge runs librivox and metadata is on', () => {
    expect(librivoxAccess(ADMIN, librivoxServer())).toBe('allowed');
    expect(mayAddLibrivox(ADMIN, librivoxServer())).toBe(true);
  });

  it('never lets in a non-admin, a household member, a kid or a demo account', () => {
    const server = librivoxServer();
    for (const user of [
      { ...ADMIN, role: 'user' as const },
      { ...ADMIN, managed_by: { id: 2, username: 'owner' } },
      { ...ADMIN, member_kind: 'kid' as const },
      { ...ADMIN, is_demo: true },
      undefined,
      null,
    ]) {
      expect(librivoxAccess(user, server)).toBe('notAdmin');
      expect(mayAddLibrivox(user, server)).toBe(false);
    }
  });

  it('is unknown while the server has not answered', () => {
    expect(librivoxAccess(ADMIN, undefined)).toBe('unknown');
    expect(mayAddLibrivox(ADMIN, undefined)).toBe(false);
  });

  it('is unavailable without the librivox feature (an older Bridge or server)', () => {
    const older = librivoxServer({ bridge: { version: '0.6.0', features: ['sidecars'] } });
    expect(librivoxAccess(ADMIN, older)).toBe('unavailable');
    expect(mayAddLibrivox(ADMIN, older)).toBe(false);
  });

  it('is unavailable while the Bridge is offline (no bridge block, the flag false)', () => {
    const caps = librivoxServer().capabilities;
    const offline = librivoxServer({ capabilities: { ...caps, bridge: false }, bridge: undefined });
    expect(librivoxAccess(ADMIN, offline)).toBe('unavailable');
    // A stale block with the flag off still reads as offline.
    expect(
      librivoxAccess(ADMIN, librivoxServer({ capabilities: { ...caps, bridge: false } })),
    ).toBe('unavailable');
  });

  it('is unavailable on an old server with neither flag nor block', () => {
    const old = librivoxServer({
      capabilities: {
        admin_ui: true,
        web_player: true,
        transcode: false,
        upload: false,
        websocket: false,
        metadata: true,
      },
      bridge: undefined,
    });
    expect(librivoxAccess(ADMIN, old)).toBe('unavailable');
  });

  it('says metadata is off when the Bridge could add but the lookup is off', () => {
    const caps = librivoxServer().capabilities;
    const off = librivoxServer({ capabilities: { ...caps, metadata: false } });
    expect(librivoxAccess(ADMIN, off)).toBe('metadataOff');
    expect(mayAddLibrivox(ADMIN, off)).toBe(false);
  });
});

describe('namesLine', () => {
  it('joins the names, skipping blank ones', () => {
    expect(
      namesLine([
        { id: 'a', name: 'Ann' },
        { id: 'b', name: ' ' },
        { id: 'c', name: 'Cy' },
      ]),
    ).toBe('Ann, Cy');
    expect(namesLine([])).toBe('');
    expect(namesLine(null)).toBe('');
  });
});

describe('fetchView (how a librivox.fetch reads)', () => {
  it('waits while queued, or running before its first step', () => {
    expect(fetchView(librivoxJob({ state: 'queued' }))).toEqual({ phase: 'waiting' });
    expect(fetchView(librivoxJob({ state: 'claimed' }))).toEqual({ phase: 'waiting' });
    expect(fetchView(librivoxJob({ progress: null }))).toEqual({ phase: 'waiting' });
  });

  it('names its step and the sections while it downloads', () => {
    expect(fetchView(librivoxJob({ progress: { step: 'download', done: 2, total: 12 } }))).toEqual({
      phase: 'running',
      step: 'download',
      done: 2,
      total: 12,
    });
    // An insane pair is left out; an unknown step (a newer Bridge) reads as working.
    expect(
      fetchView(librivoxJob({ progress: { step: 'transmogrify', done: 13, total: 12 } })),
    ).toEqual({ phase: 'running', step: 'working' });
  });

  it('is stopping once a cancel is asked', () => {
    expect(
      fetchView(librivoxJob({ cancel_requested: true, progress: { step: 'download' } })),
    ).toEqual({ phase: 'stopping' });
  });

  it('reads a park by its code, and a failure by its result code or its error', () => {
    expect(
      fetchView(
        librivoxJob({ state: 'needs_attention', progress: { park: { code: 'disk_full' } } }),
      ),
    ).toEqual({ phase: 'parked', code: 'disk_full' });
    expect(
      fetchView(librivoxJob({ state: 'failed', result: { code: 'exists' }, error: 'boom' })),
    ).toEqual({ phase: 'failed', code: 'exists' });
    expect(
      fetchView(librivoxJob({ state: 'failed', error: 'archive_unavailable: 503 from archive' })),
    ).toEqual({ phase: 'failed', code: 'archive_unavailable' });
    // The Bridge's English is never shown: an unknown code reads as other.
    expect(fetchCode(librivoxJob({ state: 'failed', error: 'kaboom' }))).toBe('other');
    expect(fetchCode(librivoxJob({ state: 'failed', result: { code: 'weird' } }))).toBe('other');
    expect(
      fetchCode(librivoxJob({ state: 'needs_attention', progress: { park: { code: 'x' } } })),
    ).toBe('other');
  });

  it('is done or cancelled once it ended so', () => {
    expect(fetchView(librivoxJob({ state: 'done' }))).toEqual({ phase: 'done' });
    expect(fetchView(librivoxJob({ state: 'cancelled' }))).toEqual({ phase: 'cancelled' });
  });

  it('has words for every step and code', () => {
    for (const step of ['manifest', 'download', 'cover', 'place', 'rescan', 'working']) {
      expect(hasKey(`librivox.fetch.step.${step}`)).toBe(true);
    }
    for (const code of [
      'not_writable',
      'exists',
      'disk_full',
      'not_found',
      'archive_unavailable',
      'metadata_off',
      'other',
    ]) {
      expect(hasKey(`librivox.fetch.code.${code}`)).toBe(true);
    }
  });
});

describe('rowState / blocksAdd', () => {
  it('is in the library first, then the followed job, then an open job not read yet', () => {
    expect(rowState(true, librivoxJob(), true)).toBe('inLibrary');
    expect(rowState(false, librivoxJob(), false)).toBe('job');
    expect(rowState(false, undefined, true)).toBe('opening');
    expect(rowState(false, undefined, false)).toBe('add');
  });

  it('holds Add back only while the job is open', () => {
    expect(blocksAdd(librivoxJob({ state: 'queued' }))).toBe(true);
    expect(blocksAdd(librivoxJob({ state: 'needs_attention' }))).toBe(true);
    expect(blocksAdd(librivoxJob({ state: 'failed' }))).toBe(false);
    expect(blocksAdd(undefined)).toBe(false);
  });
});

describe('refusals', () => {
  const refused = (status: number, code?: string) => new ApiError(status, 'English', code);

  it("words an Add's refusals by code, never the server's English", () => {
    expect(addRefusalKey(refused(409, 'in_library'))).toBe('librivox.add.inLibrary');
    expect(addRefusalKey(refused(409, 'not_book_library'))).toBe('librivox.add.notBookLibrary');
    expect(addRefusalKey(refused(409, 'kind_unavailable'))).toBe('librivox.add.unavailable');
    expect(addRefusalKey(refused(409, 'library_not_writable'))).toBe('librivox.add.notWritable');
    expect(addRefusalKey(refused(404, 'metadata_off'))).toBe('librivox.add.metadataOff');
    expect(addRefusalKey(refused(404, 'not_found'))).toBe('librivox.add.notFound');
    // A 404 with no code (no such library) reads as not found too.
    expect(addRefusalKey(refused(404))).toBe('librivox.add.notFound');
    expect(addRefusalKey(refused(502))).toBe('librivox.add.failed');
    expect(addRefusalKey(new Error('network'))).toBe('librivox.add.failed');
  });

  it('words a failed read', () => {
    expect(readErrorKey(refused(404, 'metadata_off'))).toBe('librivox.errors.metadataOff');
    expect(readErrorKey(refused(400))).toBe('librivox.errors.invalid');
    expect(readErrorKey(refused(404, 'not_found'))).toBe('librivox.errors.notFound');
    expect(readErrorKey(refused(502))).toBe('librivox.errors.failed');
  });

  it('has every refusal in the catalog', () => {
    for (const e of [
      refused(409, 'in_library'),
      refused(409, 'not_book_library'),
      refused(409, 'kind_unavailable'),
      refused(409, 'library_not_writable'),
      refused(404, 'metadata_off'),
      refused(404),
      refused(500),
    ]) {
      expect(hasKey(addRefusalKey(e))).toBe(true);
    }
    for (const e of [refused(404, 'metadata_off'), refused(400), refused(404), refused(500)]) {
      expect(hasKey(readErrorKey(e))).toBe(true);
    }
  });
});
