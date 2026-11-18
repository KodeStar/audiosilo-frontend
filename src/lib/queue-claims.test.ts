import {
  CLAIM_MS,
  CLAIM_RENEW_MS,
  type Claimed,
  claimStands,
  type QueuedSave,
  replayQueue,
  type ReplayQueue,
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
});
