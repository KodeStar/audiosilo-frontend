import type { Book, ReadalongEstimate, ServerInfo } from '@/api/types';
import { ADMIN, bridgeJob, bridgeServer } from '@/testing/bridge-fixtures';

import { mayMakeReadalong, readalongBlockedReason, readalongReady } from './readalong-gating';

// Who sees read-along and when (Bridge Phase 3c, decisions 28 and 29).

const ebook = { path: 'A/Book/Book.epub', size: 10 };
const ready = { state: 'ready', coverage: 0.99, generated_at: '2026-11-02T10:11:12Z' };

describe('readalongReady', () => {
  it('needs the capability, a ready map, the ebook and a readable book', () => {
    const book: Pick<Book, 'ebook' | 'readalong'> = { ebook, readalong: ready };
    expect(readalongReady(true, book, true)).toBe(true);
    expect(readalongReady(undefined, book, true)).toBe(false);
    expect(readalongReady(false, book, true)).toBe(false);
    expect(readalongReady(true, book, false)).toBe(false);
    expect(readalongReady(true, { readalong: ready }, true)).toBe(false);
    expect(readalongReady(true, undefined, true)).toBe(false);
  });

  it('hides a stale map, no map, and a map without its time from a listener', () => {
    expect(
      readalongReady(true, { ebook, readalong: { state: 'stale', reason: 'ebook_changed' } }, true),
    ).toBe(false);
    expect(readalongReady(true, { ebook }, true)).toBe(false);
    expect(readalongReady(true, { ebook, readalong: { state: 'ready' } }, true)).toBe(false);
  });
});

describe('mayMakeReadalong', () => {
  const server = (over: Partial<ServerInfo> = {}) => {
    const base = bridgeServer({
      bridge: { version: '0.5.0', features: ['sidecars', 'readalong'] },
    });
    return { ...base, ...over, capabilities: { ...base.capabilities, readalong: true } };
  };

  it('is an admin on a server that serves maps, with a Bridge that makes them', () => {
    expect(mayMakeReadalong(ADMIN, server())).toBe(true);
  });

  it('is never a listener, a member, a kid, a demo account, or an older server', () => {
    expect(mayMakeReadalong({ ...ADMIN, role: 'user' }, server())).toBe(false);
    expect(mayMakeReadalong({ ...ADMIN, is_demo: true }, server())).toBe(false);
    expect(
      mayMakeReadalong({ ...ADMIN, managed_by: { id: 2, username: 'parent' } }, server()),
    ).toBe(false);
    expect(mayMakeReadalong({ ...ADMIN, member_kind: 'kid' }, server())).toBe(false);
    expect(mayMakeReadalong(null, server())).toBe(false);
    expect(mayMakeReadalong(ADMIN, null)).toBe(false);
    const old = bridgeServer({ bridge: { version: '0.5.0', features: ['readalong'] } });
    expect(mayMakeReadalong(ADMIN, old)).toBe(false);
    expect(
      mayMakeReadalong(ADMIN, server({ bridge: { version: '0.4.0', features: ['sidecars'] } })),
    ).toBe(false);
    const offline = server();
    expect(
      mayMakeReadalong(ADMIN, {
        ...offline,
        capabilities: { ...offline.capabilities, bridge: false },
      }),
    ).toBe(false);
  });
});

describe('readalongBlockedReason', () => {
  const estimate = (over: Partial<ReadalongEstimate> = {}) => ({
    ebook,
    writable: true,
    ...over,
  });

  it('holds nothing back for a book it can make, or its own open job', () => {
    expect(readalongBlockedReason(estimate())).toBeNull();
    expect(
      readalongBlockedReason(estimate({ open_job: bridgeJob({ kind: 'readalong.align' }) })),
    ).toBeNull();
  });

  it('names the refusal the server would answer', () => {
    expect(readalongBlockedReason(estimate({ ebook: null }))).toBe('no_ebook');
    expect(readalongBlockedReason(estimate({ writable: false }))).toBe('library_not_writable');
    expect(readalongBlockedReason(estimate({ open_job: bridgeJob() }))).toBe('generate_open');
    expect(
      readalongBlockedReason(
        estimate({ open_job: bridgeJob({ kind: 'chapters.detect', state: 'queued' }) }),
      ),
    ).toBe('detect_open');
    // An ended job of those kinds holds nothing back; an unknown kind neither.
    expect(readalongBlockedReason(estimate({ open_job: bridgeJob({ state: 'done' }) }))).toBeNull();
    expect(
      readalongBlockedReason(estimate({ open_job: bridgeJob({ kind: 'sidecars.contribute' }) })),
    ).toBeNull();
  });
});
