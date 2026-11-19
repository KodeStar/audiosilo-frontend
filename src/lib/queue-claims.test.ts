import { Platform } from 'react-native';

import { fakeWebLocks } from '@/testing/fake-web-locks';

import {
  CLAIM_MS,
  CLAIM_RENEW_MS,
  type ClaimCheck,
  claimLockName,
  type Claimed,
  claimStands,
  type QueuedSave,
  replayQueue,
  type ReplayQueue,
  TAKE_OVER_WAIT_MS,
  unclaimed,
} from './queue-claims';

describe('queue claims', () => {
  const now = 1_000_000;

  it('a claim stands until it runs out, and not when it stands further ahead than any is written for', () => {
    expect(claimStands({}, now)).toBe(false);
    expect(claimStands({ claim: { id: 'a', until: now + 1 } }, now)).toBe(true);
    expect(claimStands({ claim: { id: 'a', until: now } }, now)).toBe(false);
    // The clock set back since the claim was written.
    expect(claimStands({ claim: { id: 'a', until: now + CLAIM_MS + 1 } }, now)).toBe(false);
    expect(claimStands({ claim: 'junk' }, now)).toBe(false);
  });

  it('unclaimed drops the claim only', () => {
    expect(unclaimed({ a: 1, claim: { id: 'x', until: 1 } })).toEqual({ a: 1 });
  });

  it('drops, keeps and sends by connection, and a send that throws keeps its entries', async () => {
    const entry = (connectionId: string, n: number) => ({
      connectionId,
      libraryId: 1,
      path: `Book ${n}`,
      updated_at: `2026-01-0${n}T00:00:00Z`,
    });
    type E = ReturnType<typeof entry>;
    let stored: (E & { claim?: { id: string; until: number } })[] = [
      entry('gone', 1),
      entry('down', 2),
      entry('up', 3),
      entry('broken', 4),
    ];
    const sent: string[] = [];
    await replayQueue<E, string>({
      lock: (job) => job(),
      read: async () => stored,
      write: async (next) => void (stored = next),
      route: (cid) => (cid === 'gone' ? 'drop' : cid === 'down' ? 'keep' : { send: cid }),
      send: async (cid, _client, entries) => {
        if (cid === 'broken') throw new Error('no');
        sent.push(...entries.map((e) => e.path));
        return [];
      },
      sent: new Set(),
    });
    expect(sent).toEqual(['Book 3']);
    expect(stored).toEqual([entry('down', 2), entry('broken', 4)]);
  });

  it('takes no lock when there is nothing to claim', async () => {
    const lock = jest.fn((job: () => Promise<unknown>) => job()) as ReplayQueue<
      QueuedSave,
      string
    >['lock'];
    const claimed = {
      connectionId: 'up',
      libraryId: 1,
      path: 'A',
      updated_at: '2026-01-01T00:00:00Z',
      claim: { id: 'other', until: Date.now() + 60_000 },
    };
    for (const queue of [[], [claimed]]) {
      await replayQueue<QueuedSave, string>({
        lock,
        read: async () => queue,
        write: async () => undefined,
        route: (cid) => ({ send: cid }),
        send: async () => [],
        sent: new Set(),
      });
    }
    expect(lock).not.toHaveBeenCalled();
  });

  describe('claims kept alive, and storage that refuses a write', () => {
    type E = QueuedSave;
    const entry: E = {
      connectionId: 'up',
      libraryId: 1,
      path: 'A',
      updated_at: '2026-01-01T00:00:00Z',
    };

    /** A queue over an array, whose writes `refuse` can turn down. */
    function memoryQueue(send: ReplayQueue<E, string>['send']) {
      const state = { stored: [entry] as Claimed<E>[], refuse: false, writes: 0 };
      const q: ReplayQueue<E, string> = {
        lock: (job) => job(),
        read: async () => state.stored,
        write: async (next) => {
          if (state.refuse) throw new Error('quota');
          state.writes++;
          state.stored = next;
        },
        route: (cid) => ({ send: cid }),
        send,
        sent: new Set(),
      };
      return { q, state };
    }

    it('stamps its claims again while it sends, so they stand only while its tab lives', async () => {
      jest.useFakeTimers();
      try {
        let answer!: () => void;
        const { q, state } = memoryQueue(() => new Promise((r) => (answer = () => r([]))));
        const replay = replayQueue(q);
        await jest.advanceTimersByTimeAsync(0);
        const first = state.stored[0].claim!.until;
        // Written to stand two renewals, not for a fixed couple of minutes.
        expect(first - Date.now()).toBe(CLAIM_MS);
        expect(CLAIM_MS).toBe(2 * CLAIM_RENEW_MS);
        await jest.advanceTimersByTimeAsync(CLAIM_RENEW_MS);
        expect(state.stored[0].claim!.until).toBe(first + CLAIM_RENEW_MS);
        // Long past the first stamp, still sending: another tab leaves it alone.
        await jest.advanceTimersByTimeAsync(3 * CLAIM_RENEW_MS);
        expect(claimStands(state.stored[0])).toBe(true);
        answer();
        await replay;
        expect(state.stored).toEqual([]);
        // Settled: nothing stamps on.
        const writes = state.writes;
        await jest.advanceTimersByTimeAsync(2 * CLAIM_RENEW_MS);
        expect(state.writes).toBe(writes);
      } finally {
        jest.useRealTimers();
      }
    });

    it('a claim its tab stopped renewing runs out two renewals on', () => {
      const now = 1_000_000;
      const claim = { id: 'gone', until: now + CLAIM_MS };
      expect(claimStands({ claim }, now + 2 * CLAIM_RENEW_MS - 1)).toBe(true);
      expect(claimStands({ claim }, now + 2 * CLAIM_RENEW_MS)).toBe(false);
    });

    it('sends nothing when its claim could not be stored, and tries again later', async () => {
      const send = jest.fn(async () => []);
      const { q, state } = memoryQueue(send);
      state.refuse = true;
      await replayQueue(q);
      expect(send).not.toHaveBeenCalled();
      expect(state.stored).toEqual([entry]);
      state.refuse = false;
      await replayQueue(q);
      expect(send).toHaveBeenCalledTimes(1);
      expect(state.stored).toEqual([]);
    });

    // A sign-out's last send has no next replay: kept, the entry went with the purge unsent.
    it.each(['web', 'ios'] as const)(
      'a sign-out’s last send sends unclaimed what storage would not let it claim (%s)',
      async (os) => {
        const was = Platform.OS;
        Platform.OS = os;
        try {
          const send = jest.fn(async () => []);
          const { q, state } = memoryQueue(send);
          q.takeOver = true;
          // The claim's write is refused; the settle's goes through.
          const write = q.write;
          let refuse = true;
          q.write = async (next, before) => {
            if (refuse) {
              refuse = false;
              throw new Error('quota');
            }
            return write(next, before);
          };
          await replayQueue(q);
          expect(send).toHaveBeenCalledTimes(1);
          expect(send.mock.calls[0]).toEqual(['up', 'up', [entry], expect.any(Function)]);
          expect(state.stored).toEqual([]);
        } finally {
          Platform.OS = was;
        }
      },
    );

    it('never sends again an entry it sent whose removal storage refused', async () => {
      const { q, state } = memoryQueue(async () => {
        state.refuse = true; // the queue can no longer be written once the save is out
        return [];
      });
      const send = jest.spyOn(q, 'send');
      await replayQueue(q);
      expect(send).toHaveBeenCalledTimes(1);
      // Still queued, under the claim that could not be taken off.
      expect(state.stored).toHaveLength(1);
      // Its claim run out, storage still full: not sent again from this tab.
      state.stored = [entry];
      await replayQueue(q);
      expect(send).toHaveBeenCalledTimes(1);
      // Storage takes writes again: the entry leaves the queue, unsent.
      state.refuse = false;
      await replayQueue(q);
      expect(send).toHaveBeenCalledTimes(1);
      expect(state.stored).toEqual([]);
      expect(q.sent.size).toBe(0);
    });
  });

  // The web player's tabs share one queue: a hidden tab's timers are throttled (a minute
  // apart or more), so its renewals fell behind a replay still sending, and another tab took
  // the claim and sent the same entries while its requests were out.
  describe('across tabs', () => {
    // Node has Web Locks of its own: each test sets this browser's (none: plain http).
    const nav = globalThis.navigator as { locks?: unknown };
    const setLocks = (value: unknown) =>
      Object.defineProperty(nav, 'locks', { configurable: true, value });
    beforeEach(() => setLocks(undefined));
    afterEach(() => {
      delete nav.locks;
    });

    const at = (path: string, connectionId = 'up'): QueuedSave => ({
      connectionId,
      libraryId: 1,
      path,
      updated_at: '2026-01-01T00:00:00Z',
    });

    /** The tabs' one stored queue, and what each tab sent. */
    function sharedQueue(entries: Claimed<QueuedSave>[]) {
      const state = { stored: entries, sent: [] as string[] };
      /** A tab's replay over it: `send` (by default every entry at once) through `mine`. */
      const tab = (
        name: string,
        opts: {
          hold?: (path: string) => Promise<void> | undefined;
          takeOver?: boolean;
          route?: ReplayQueue<QueuedSave, string>['route'];
        } = {},
      ): ReplayQueue<QueuedSave, string> => ({
        lock: (job) => job(),
        read: async () => state.stored,
        write: async (next) => void (state.stored = next),
        route: opts.route ?? ((cid) => ({ send: cid })),
        send: async (_cid, _client, sending, mine: ClaimCheck<QueuedSave>) => {
          const kept: QueuedSave[] = [];
          for (const e of sending) {
            if (!(await mine(e))) {
              kept.push(e);
              continue;
            }
            state.sent.push(`${name}:${e.path}`);
            await opts.hold?.(e.path);
          }
          return kept;
        },
        sent: new Set(),
        takeOver: opts.takeOver,
      });
      return { state, tab };
    }

    const tick = () => new Promise((r) => setTimeout(r, 0));

    /** A promise and its resolve. */
    function gate() {
      let open!: () => void;
      const shut = new Promise<void>((r) => (open = r));
      return { shut, open };
    }

    it('a claim stands while its tab holds its lock, however far behind its stamps fell', async () => {
      setLocks(fakeWebLocks());
      const { state, tab } = sharedQueue([at('A')]);
      const out = gate();
      const a = replayQueue(tab('a', { hold: () => out.shut }));
      await tick();
      // No renewal ran (the tab's timers throttled), and the claim's time has run out.
      const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + CLAIM_MS + 1);
      try {
        await replayQueue(tab('b'));
        expect(state.sent).toEqual(['a:A']);
      } finally {
        clock.mockRestore();
      }
      out.open();
      await a;
      expect(state.stored).toEqual([]);
      expect(state.sent).toEqual(['a:A']);
    });

    it('a send checks its claim first: one another tab took meanwhile goes once', async () => {
      // No Web Locks (plain http): the claim stands by its time alone.
      const { state, tab } = sharedQueue([at('A'), at('B')]);
      const out = gate();
      const a = replayQueue(tab('a', { hold: (path) => (path === 'A' ? out.shut : undefined) }));
      await tick();
      const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + CLAIM_MS + 1);
      try {
        // A's request for A outlived the claim: the other tab claims both and sends them.
        await replayQueue(tab('b'));
        out.open();
        await a;
      } finally {
        clock.mockRestore();
      }
      expect(state.sent).toEqual(['a:A', 'b:A', 'b:B']);
      expect(state.stored).toEqual([]);
    });

    it('a send near its claim’s end stamps the claim again first', async () => {
      const { state, tab } = sharedQueue([at('A'), at('B')]);
      const out = gate();
      // The claims as stored when B goes (the replay's settle takes them off after).
      let stamped: (number | undefined)[] = [];
      const a = replayQueue(
        tab('a', {
          hold: (path) => {
            if (path === 'A') return out.shut;
            stamped = state.stored.map((e) => e.claim?.until);
            return undefined;
          },
        }),
      );
      await tick();
      const claimed = state.stored[0].claim!.until;
      const later = claimed - CLAIM_RENEW_MS + 1;
      const clock = jest.spyOn(Date, 'now').mockReturnValue(later);
      try {
        // B goes once A is answered: its claim is stamped again on the way.
        out.open();
        await a;
      } finally {
        clock.mockRestore();
      }
      expect(state.sent).toEqual(['a:A', 'a:B']);
      expect(stamped).toEqual([later + CLAIM_MS, later + CLAIM_MS]);
      expect(state.stored).toEqual([]);
    });

    // Between the check's read and its stamp under the lock, another replay took the entry.
    it('a send whose stamp finds the entry taken by another replay leaves it', async () => {
      const { state, tab } = sharedQueue([at('A'), at('B')]);
      const out = gate();
      const q = tab('a', { hold: (path) => (path === 'A' ? out.shut : undefined) });
      const other = { id: 'other', until: 0 };
      let take = false;
      q.lock = (job) => {
        if (take) {
          take = false;
          state.stored = state.stored.map((e) =>
            e.path === 'B' ? { ...unclaimed(e), claim: other } : e,
          );
        }
        return job();
      };
      const a = replayQueue(q);
      await tick();
      const later = state.stored[0].claim!.until - CLAIM_RENEW_MS + 1;
      other.until = later + CLAIM_MS;
      const clock = jest.spyOn(Date, 'now').mockReturnValue(later);
      try {
        take = true;
        out.open();
        await a;
      } finally {
        clock.mockRestore();
      }
      expect(state.sent).toEqual(['a:A']);
      expect(state.stored.map((e) => [e.path, e.claim?.id])).toEqual([['B', 'other']]);
    });

    describe('storage refuses the stamp of a claim near its end', () => {
      /** A's replay with A out, and a queue that takes no write once `full`. */
      function refusing(takeOver = false) {
        const { state, tab } = sharedQueue([at('A'), at('B')]);
        const out = gate();
        const q = tab('a', { takeOver, hold: (path) => (path === 'A' ? out.shut : undefined) });
        const store = { full: false };
        const write = q.write;
        q.write = async (next, before) => {
          if (store.full) throw new Error('quota');
          return write(next, before);
        };
        return { state, q, out, store, replay: replayQueue(q) };
      }

      it('still sends an entry whose claim stands by its time', async () => {
        const { state, q, out, store, replay } = refusing();
        await tick();
        const later = state.stored[0].claim!.until - CLAIM_RENEW_MS + 1;
        const clock = jest.spyOn(Date, 'now').mockReturnValue(later);
        try {
          store.full = true;
          out.open();
          await replay;
        } finally {
          clock.mockRestore();
        }
        expect(state.sent).toEqual(['a:A', 'a:B']);
        // Their removal refused too: remembered, never sent again from this tab.
        expect(q.sent.size).toBe(2);
      });

      it('sends nothing more once the claim it has ran out', async () => {
        const { state, out, store, replay } = refusing();
        await tick();
        const clock = jest.spyOn(Date, 'now').mockReturnValue(state.stored[0].claim!.until + 1);
        try {
          store.full = true;
          out.open();
          await replay;
        } finally {
          clock.mockRestore();
        }
        expect(state.sent).toEqual(['a:A']);
      });

      // Kept, it had no later replay: the connection's purge took it unsent.
      it('still sends it in a sign-out’s last send', async () => {
        const { state, out, store, replay } = refusing(true);
        await tick();
        const clock = jest.spyOn(Date, 'now').mockReturnValue(state.stored[0].claim!.until + 1);
        try {
          store.full = true;
          out.open();
          await replay;
        } finally {
          clock.mockRestore();
        }
        expect(state.sent).toEqual(['a:A', 'a:B']);
      });
    });

    describe('a queue the check before a send could not read', () => {
      /** A's replay with A out, whose check of B finds storage unreadable once `broken`. */
      function unreadable(takeOver: boolean) {
        const { state, tab } = sharedQueue([at('A'), at('B')]);
        const out = gate();
        const q = tab('a', { takeOver, hold: (path) => (path === 'A' ? out.shut : undefined) });
        const store = { broken: false };
        q.readStrict = async () => {
          if (store.broken) throw new Error('unreadable');
          return state.stored;
        };
        return { state, out, store, replay: replayQueue(q) };
      }

      it('keeps the entry for the next replay', async () => {
        const { state, out, store, replay } = unreadable(false);
        await tick();
        store.broken = true;
        out.open();
        await replay;
        expect(state.sent).toEqual(['a:A']);
        expect(state.stored).toEqual([at('B')]);
      });

      // A sign-out's has no next replay, on any platform: kept, the entry went with the
      // connection's purge unsent.
      it('sends it in a sign-out’s last send', async () => {
        const { state, out, store, replay } = unreadable(true);
        await tick();
        store.broken = true;
        out.open();
        await replay;
        expect(state.sent).toEqual(['a:A', 'a:B']);
        expect(state.stored).toEqual([]);
      });
    });

    describe("a sign-out's last send (takeOver)", () => {
      const claimedBy = (id: string, path: string, connectionId = 'up') => ({
        ...at(path, connectionId),
        claim: { id, until: Date.now() + CLAIM_MS },
      });
      const upOnly: ReplayQueue<QueuedSave, string>['route'] = (cid) =>
        cid === 'up' ? { send: cid } : 'keep';
      // Only the web's tabs share a queue.
      let os: typeof Platform.OS;
      beforeEach(() => {
        os = Platform.OS;
        Platform.OS = 'web';
      });
      afterEach(() => {
        Platform.OS = os;
      });

      it('waits for another tab’s live claim, then takes over what it left', async () => {
        const locks = fakeWebLocks();
        setLocks(locks);
        const other = gate();
        void locks.request(claimLockName('other'), () => other.shut);
        const { state, tab } = sharedQueue([
          claimedBy('other', 'A'),
          claimedBy('other', 'B', 'else'),
        ]);
        let done = false;
        const last = replayQueue(tab('a', { takeOver: true, route: upOnly })).then(
          () => (done = true),
        );
        await tick();
        await tick();
        expect(done).toBe(false);
        expect(state.sent).toEqual([]);
        // The other tab let its claim go, A still queued (its send failed there).
        other.open();
        await last;
        expect(state.sent).toEqual(['a:A']);
        // Another connection's entry keeps the other tab's claim.
        expect(state.stored.map((e) => [e.path, e.claim?.id])).toEqual([['B', 'other']]);
      });

      // Two last sends at once (a tab told of another's sign-out runs its own): the other took
      // B over while A was out here, and this tab's token was revoked under its send of B.
      it('waits again for another last send that took its claims over while it sent', async () => {
        const locks = fakeWebLocks();
        setLocks(locks);
        const { state, tab } = sharedQueue([at('A'), at('B')]);
        const out = gate();
        const other = gate();
        let done = false;
        const last = replayQueue(
          tab('a', {
            takeOver: true,
            hold: (path) => {
              if (path !== 'A') return undefined;
              state.stored = state.stored.map((e) =>
                e.path === 'B'
                  ? { ...unclaimed(e), claim: { id: 'other', until: Date.now() + CLAIM_MS } }
                  : e,
              );
              void locks.request(claimLockName('other'), () => other.shut);
              return out.shut;
            },
          }),
        ).then(() => (done = true));
        await tick();
        out.open();
        await tick();
        await tick();
        expect(done).toBe(false);
        expect(state.sent).toEqual(['a:A']);
        // Its send of B over there, the other tab lets its claim go.
        other.open();
        await last;
        expect(state.stored.map((e) => [e.path, e.claim?.id])).toEqual([['B', 'other']]);
      });

      // Another connection's entries are not this sign-out's: a claim on them is no wait.
      it('does not wait for a live claim on another connection’s entries', async () => {
        const locks = fakeWebLocks();
        setLocks(locks);
        void locks.request(claimLockName('other'), () => new Promise<void>(() => {}));
        const { state, tab } = sharedQueue([at('A'), claimedBy('other', 'B', 'else')]);
        await replayQueue(tab('a', { takeOver: true, route: upOnly }));
        expect(state.sent).toEqual(['a:A']);
        expect(state.stored.map((e) => [e.path, e.claim?.id])).toEqual([['B', 'other']]);
      });

      it('takes over at once a claim no lock holds (plain http, or its tab gone)', async () => {
        const { state, tab } = sharedQueue([claimedBy('other', 'A')]);
        await replayQueue(tab('a'));
        expect(state.sent).toEqual([]);
        await replayQueue(tab('a', { takeOver: true }));
        expect(state.sent).toEqual(['a:A']);
        expect(state.stored).toEqual([]);
      });

      // Off the web the app is one process: a claim an earlier launch wrote was left by a
      // run that ended (killed mid-replay), and the purge after a last send took it unsent.
      it('takes off the web a claim another launch left, as free', async () => {
        Platform.OS = 'ios';
        const { state, tab } = sharedQueue([claimedBy('other', 'A')]);
        // An everyday replay leaves it to its claim's time.
        await replayQueue(tab('a'));
        expect(state.sent).toEqual([]);
        await replayQueue(tab('a', { takeOver: true }));
        expect(state.sent).toEqual(['a:A']);
        expect(state.stored).toEqual([]);
      });

      it('leaves off the web a claim this launch’s other replay holds', async () => {
        Platform.OS = 'ios';
        const { state, tab } = sharedQueue([at('A')]);
        const out = gate();
        const b = replayQueue(tab('b', { hold: () => out.shut }));
        await tick();
        await replayQueue(tab('a', { takeOver: true }));
        expect(state.sent).toEqual(['b:A']);
        out.open();
        await b;
        expect(state.sent).toEqual(['b:A']);
        expect(state.stored).toEqual([]);
      });

      it('takes over a claim still live once it has waited long enough', async () => {
        jest.useFakeTimers();
        try {
          const locks = fakeWebLocks();
          setLocks(locks);
          void locks.request(claimLockName('other'), () => new Promise<void>(() => {}));
          const { state, tab } = sharedQueue([claimedBy('other', 'A')]);
          const last = replayQueue(tab('a', { takeOver: true }));
          await jest.advanceTimersByTimeAsync(TAKE_OVER_WAIT_MS - 1);
          expect(state.sent).toEqual([]);
          await jest.advanceTimersByTimeAsync(1);
          await last;
          expect(state.sent).toEqual(['a:A']);
        } finally {
          jest.useRealTimers();
        }
      });

      // Unclaimed, the other tab is never told: it sends its entry too (a bookmark twice).
      it('leaves to a tab still holding its claim’s lock what storage would not let it claim', async () => {
        jest.useFakeTimers();
        try {
          const locks = fakeWebLocks();
          setLocks(locks);
          void locks.request(claimLockName('other'), () => new Promise<void>(() => {}));
          const { state, tab } = sharedQueue([claimedBy('other', 'A'), at('B')]);
          const q = tab('a', { takeOver: true });
          let refuse = true;
          const write = q.write;
          q.write = async (next, before) => {
            if (refuse) {
              refuse = false;
              throw new Error('quota');
            }
            return write(next, before);
          };
          const last = replayQueue(q);
          await jest.advanceTimersByTimeAsync(TAKE_OVER_WAIT_MS);
          await last;
          expect(state.sent).toEqual(['a:B']);
          expect(state.stored.map((e) => [e.path, e.claim?.id])).toEqual([['A', 'other']]);
        } finally {
          jest.useRealTimers();
        }
      });

      // The bookmarks' send compares the claim it is given with the stored one: a claim of
      // this replay's that never was stored held every fresh bookmark back.
      it('checks an unclaimed send against the claim each entry carries as stored', async () => {
        Platform.OS = 'ios';
        const { state, tab } = sharedQueue([claimedBy('other', 'A'), at('B')]);
        const q = tab('a', { takeOver: true });
        q.write = async () => {
          throw new Error('quota');
        };
        const seen: (string | undefined)[] = [];
        q.send = async (_cid, _client, sending, mine) => {
          for (const e of sending) seen.push((await mine(e))?.claim?.id);
          return [];
        };
        await replayQueue(q);
        expect(seen).toEqual(['other', undefined]);
        expect(state.stored.map((e) => e.claim?.id)).toEqual(['other', undefined]);
      });
    });
  });
});
