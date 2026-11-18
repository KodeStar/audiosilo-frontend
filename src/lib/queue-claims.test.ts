import {
  CLAIM_MS,
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
      });
    }
    expect(lock).not.toHaveBeenCalled();
  });
});
