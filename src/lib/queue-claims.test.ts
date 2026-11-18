import { CLAIM_MS, claimStands, replayQueue, unclaimed } from './queue-claims';

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
    type E = { cid: string; n: number };
    let stored: (E & { claim?: { id: string; until: number } })[] = [
      { cid: 'gone', n: 1 },
      { cid: 'down', n: 2 },
      { cid: 'up', n: 3 },
      { cid: 'broken', n: 4 },
    ];
    const sent: number[] = [];
    await replayQueue<E, string>({
      lock: (job) => job(),
      read: async () => stored,
      write: async (next) => void (stored = next),
      connectionOf: (e) => e.cid,
      keyOf: (e) => String(e.n),
      route: (cid) => (cid === 'gone' ? 'drop' : cid === 'down' ? 'keep' : { send: cid }),
      send: async (cid, _client, entries) => {
        if (cid === 'broken') throw new Error('no');
        sent.push(...entries.map((e) => e.n));
        return [];
      },
    });
    expect(sent).toEqual([3]);
    expect(stored).toEqual([
      { cid: 'down', n: 2 },
      { cid: 'broken', n: 4 },
    ]);
  });
});
