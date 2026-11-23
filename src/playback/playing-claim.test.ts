import { Platform } from 'react-native';

import { setConnectionAliases } from '@/lib/connection-id';
import { tabChannel } from '@/lib/tab-channel';
import { fakeBrowser } from '@/testing/fake-browser';

import {
  bookPlayPressed,
  type GaveWay,
  givesWayTo,
  newerTabPlay,
  type OwnPlay,
  PLAYING_CHANNEL,
  type PlayingClaim,
  playingClaims,
  resetTabClaimsForTests,
  tabClaims,
} from './playing-claim';

const settle = () => new Promise((r) => setTimeout(r, 0));

const claim = (over: Partial<PlayingClaim> = {}): PlayingClaim => ({
  connectionId: 'c1',
  tab: 'tab-b',
  askedAt: 2000,
  sentAt: 2500,
  ...over,
});
const mine = (over: Partial<OwnPlay> = {}): OwnPlay => ({
  tab: 'tab-a',
  connectionId: 'c1',
  live: true,
  askedAt: 1000,
  ...over,
});

describe('givesWayTo (one tab plays at a time per connection)', () => {
  it('a playing tab gives way to a play asked for later', () => {
    expect(givesWayTo(claim(), mine())).toBe(true);
  });

  it('a tab with nothing playing gives way to nothing', () => {
    expect(givesWayTo(claim(), mine({ live: false }))).toBe(false);
    expect(givesWayTo(claim(), mine({ connectionId: null, live: false }))).toBe(false);
  });

  // A tab that followed another tab's identity migration claims under the new id; this one
  // loaded its book before it, under the old.
  it('gives way to a claim on its connection under the id it was renamed to', () => {
    setConnectionAliases({ c1: 'c1.7' });
    try {
      expect(givesWayTo(claim({ connectionId: 'c1.7' }), mine())).toBe(true);
    } finally {
      setConnectionAliases({});
    }
  });

  it('another connection plays on: the rule is per connection', () => {
    expect(givesWayTo(claim({ connectionId: 'c2' }), mine())).toBe(false);
  });

  it('a play asked for after the claimed one stands (its own claim follows)', () => {
    expect(givesWayTo(claim({ askedAt: 500 }), mine())).toBe(false);
  });

  it('two plays asked for in the same millisecond: exactly one stands', () => {
    const a = mine({ askedAt: 2000 });
    const b = mine({ tab: 'tab-b', askedAt: 2000 });
    const aYields = givesWayTo(claim({ tab: 'tab-b', askedAt: 2000 }), a);
    const bYields = givesWayTo(claim({ tab: 'tab-a', askedAt: 2000 }), b);
    expect([aYields, bYields].filter(Boolean)).toHaveLength(1);
  });

  it('after the clock was set back, a play asked for since is the newer one', () => {
    const clock = jest.spyOn(Date, 'now');
    try {
      const hour = 60 * 60_000;
      const then = 1_800_000_000_000;
      clock.mockReturnValue(then - hour);
      // This tab's play, from before the step, gives way to a claim asked for since.
      expect(
        givesWayTo(claim({ askedAt: then - hour, sentAt: then - hour }), mine({ askedAt: then })),
      ).toBe(true);
      // A claim of a play from before the step takes nothing from a play asked for since.
      expect(
        givesWayTo(claim({ askedAt: then, sentAt: then - hour }), mine({ askedAt: then - hour })),
      ).toBe(false);
      // Both from before it: the later stands, as ever.
      expect(givesWayTo(claim({ askedAt: then + 5 }), mine({ askedAt: then }))).toBe(true);
    } finally {
      clock.mockRestore();
    }
  });

  it("never to the tab's own claim", () => {
    expect(givesWayTo(claim({ tab: 'tab-a', askedAt: 9000 }), mine())).toBe(false);
  });
});

describe('playingClaims', () => {
  const os = Platform.OS;
  beforeEach(() => {
    Platform.OS = 'web';
  });
  afterEach(() => {
    Platform.OS = os;
    resetTabClaimsForTests();
  });

  it.each([
    ['BroadcastChannel', true],
    ['storage events', false],
  ])(
    "a tab's claim reaches the other tabs over %s, with when it was made",
    async (_n, broadcast) => {
      const browser = fakeBrowser({ broadcast });
      const a = playingClaims(tabChannel(PLAYING_CHANNEL, browser.tab()), 'tab-a');
      const b = playingClaims(tabChannel(PLAYING_CHANNEL, browser.tab()), 'tab-b');
      const heardByA: PlayingClaim[] = [];
      const heardByB: PlayingClaim[] = [];
      a.subscribe((c) => heardByA.push(c));
      b.subscribe((c) => heardByB.push(c));
      const before = Date.now();
      a.announce('c1', 1234);
      await settle();
      expect(heardByA).toEqual([]);
      expect(heardByB).toEqual([
        { connectionId: 'c1', tab: 'tab-a', askedAt: 1234, sentAt: expect.any(Number) },
      ]);
      expect(heardByB[0].sentAt).toBeGreaterThanOrEqual(before);
      expect(heardByB[0].sentAt).toBeLessThanOrEqual(Date.now());
    },
  );

  it.each([
    ['BroadcastChannel', true],
    ['storage events', false],
  ])(
    'an answer reaches the tab whose claim it answers, and only that tab, over %s',
    async (_n, broadcast) => {
      const browser = fakeBrowser({ broadcast });
      const [a, b, c] = ['tab-a', 'tab-b', 'tab-c'].map((id) =>
        playingClaims(tabChannel(PLAYING_CHANNEL, browser.tab()), id),
      );
      const claimsHeard: PlayingClaim[] = [];
      const answers: Record<string, GaveWay[]> = { a: [], b: [], c: [] };
      a.subscribe(
        (heard) => claimsHeard.push(heard),
        (answer) => answers.a.push(answer),
      );
      b.subscribe(
        () => {},
        (answer) => answers.b.push(answer),
      );
      c.subscribe(
        () => {},
        (answer) => answers.c.push(answer),
      );
      const made = b.announce('c1', 1234);
      await settle();
      expect(claimsHeard).toEqual([made]);
      const stopped = {
        connectionId: 'c1',
        libraryId: 2,
        path: 'A/Book',
        position: 47,
        file: 'A/Book/1.mp3',
        filePos: 47,
        finished: false,
      };
      a.answer(made, stopped);
      await settle();
      expect(answers.b).toEqual([
        { ...stopped, kind: 'gave-way', tab: 'tab-a', to: 'tab-b', askedAt: made.askedAt },
      ]);
      expect(answers.a).toEqual([]);
      expect(answers.c).toEqual([]);
      // Never read as a claim by anyone.
      expect(claimsHeard).toEqual([made]);
    },
  );

  it('ignores an answer that is not one', async () => {
    const browser = fakeBrowser();
    const raw = tabChannel<unknown>(PLAYING_CHANNEL, browser.tab())!;
    const b = playingClaims(tabChannel(PLAYING_CHANNEL, browser.tab()), 'tab-b');
    const answers: GaveWay[] = [];
    b.subscribe(
      () => {},
      (answer) => answers.push(answer),
    );
    const good = {
      kind: 'gave-way',
      connectionId: 'c1',
      libraryId: 2,
      path: 'A/Book',
      position: 47,
      finished: false,
      tab: 'tab-a',
      to: 'tab-b',
      askedAt: 1,
    };
    raw.post({ ...good, position: Number.NaN });
    raw.post({ ...good, kind: 'left' });
    raw.post({ ...good, path: 7 });
    raw.post({ ...good, filePos: 'far' });
    raw.post({ ...good, to: 'tab-z' });
    // An answer that names a claim message, not the play (no `askedAt`).
    raw.post({ ...good, askedAt: undefined, claimedAt: 1 });
    await settle();
    expect(answers).toEqual([]);
    raw.post(good);
    await settle();
    expect(answers).toEqual([good]);
  });

  it('ignores what is not a claim', async () => {
    const browser = fakeBrowser();
    const raw = tabChannel<unknown>(PLAYING_CHANNEL, browser.tab())!;
    const b = playingClaims(tabChannel(PLAYING_CHANNEL, browser.tab()), 'tab-b');
    const heard: PlayingClaim[] = [];
    b.subscribe((c) => heard.push(c));
    raw.post('play');
    raw.post({ connectionId: 'c1', tab: 'x', askedAt: 'now', sentAt: 1 });
    raw.post({ connectionId: 'c1', tab: 'x', askedAt: 1, sentAt: Number.NaN });
    raw.post(null);
    await settle();
    expect(heard).toEqual([]);
  });

  it('with no channel (the app) nothing is said or heard', () => {
    const claims = playingClaims(null);
    const heard = jest.fn();
    const stop = claims.subscribe(heard);
    expect(() => claims.announce('c1', 1)).not.toThrow();
    stop();
    expect(heard).not.toHaveBeenCalled();
  });

  it("the app's own claims have no channel", () => {
    Platform.OS = 'ios';
    resetTabClaimsForTests();
    const heard = jest.fn();
    tabClaims().subscribe(heard);
    tabClaims().announce('c1', 1);
    expect(heard).not.toHaveBeenCalled();
    expect(tabClaims()).toBe(tabClaims()); // opened once
  });

  // Two tabs press play within a moment of each other: each hears the other's claim.
  it('two tabs that start together end with exactly one playing', async () => {
    const browser = fakeBrowser();
    const tabs = ['tab-a', 'tab-b'].map((id, i) => {
      const claims = playingClaims(tabChannel(PLAYING_CHANNEL, browser.tab()), id);
      const play: OwnPlay = { tab: id, connectionId: 'c1', live: true, askedAt: 5000 + i };
      claims.subscribe((c) => {
        if (givesWayTo(c, play)) play.live = false;
      });
      return { claims, play };
    });
    for (const t of tabs) t.claims.announce('c1', t.play.askedAt);
    await settle();
    expect(tabs.map((t) => t.play.live)).toEqual([false, true]); // the later ask stands
  });

  it('a newer claim found under the id the press was noted by, the other id of one connection', async () => {
    const browser = fakeBrowser();
    const g = globalThis as Record<string, unknown>;
    const saved = g.BroadcastChannel;
    g.BroadcastChannel = browser.tab().BroadcastChannel;
    setConnectionAliases({ c1: 'c1.7' });
    try {
      // The press noted under the target's (legacy) id, the claim made under the new one.
      const pressed = bookPlayPressed('c1');
      const other = playingClaims(tabChannel(PLAYING_CHANNEL, browser.tab()), 'tab-z');
      const made = other.announce('c1.7', pressed + 1);
      await settle();
      // Checked against the loaded book's (new) id.
      expect(newerTabPlay('c1.7', pressed)).toEqual(made);
      expect(newerTabPlay('c1', pressed)).toEqual(made);
      expect(newerTabPlay('c1.7', pressed + 2)).toBeNull();
    } finally {
      g.BroadcastChannel = saved;
      setConnectionAliases({});
    }
  });

  it('a claim from before the clock was set back holds no press since, nor a newer claim off', async () => {
    const browser = fakeBrowser();
    const g = globalThis as Record<string, unknown>;
    const saved = g.BroadcastChannel;
    g.BroadcastChannel = browser.tab().BroadcastChannel;
    const clock = jest.spyOn(Date, 'now');
    try {
      const hour = 60 * 60_000;
      const then = Date.now();
      clock.mockReturnValue(then);
      bookPlayPressed('c1');
      const other = playingClaims(tabChannel(PLAYING_CHANNEL, browser.tab()), 'tab-z');
      other.announce('c1', then);
      await settle();
      // The clock is set back an hour: that claim is "newer" than every press for an hour.
      clock.mockReturnValue(then - hour);
      expect(newerTabPlay('c1', bookPlayPressed('c1'))).toBeNull();
      // A claim made since is still found.
      const made = other.announce('c1', then - hour + 10);
      await settle();
      expect(newerTabPlay('c1', then - hour + 5)).toEqual(made);
    } finally {
      clock.mockRestore();
      g.BroadcastChannel = saved;
    }
  });

  it('a play from before the clock step, claimed again since, gives the kept claim to a play asked since', async () => {
    const browser = fakeBrowser();
    const g = globalThis as Record<string, unknown>;
    const saved = g.BroadcastChannel;
    g.BroadcastChannel = browser.tab().BroadcastChannel;
    const clock = jest.spyOn(Date, 'now');
    try {
      const hour = 60 * 60_000;
      const then = Date.now();
      clock.mockReturnValue(then - hour);
      // Another tab's play asked for before the step goes on (a buffer): claimed again, sent now.
      const old = playingClaims(tabChannel(PLAYING_CHANNEL, browser.tab()), 'tab-y');
      const pressed = bookPlayPressed('c1');
      old.announce('c1', then);
      await settle();
      // A third tab's play asked for since this press is the newer one, and is found.
      const other = playingClaims(tabChannel(PLAYING_CHANNEL, browser.tab()), 'tab-z');
      const made = other.announce('c1', pressed + 1);
      await settle();
      expect(newerTabPlay('c1', pressed)).toEqual(made);
    } finally {
      clock.mockRestore();
      g.BroadcastChannel = saved;
    }
  });
});
