import { Platform } from 'react-native';

import { tabChannel } from '@/lib/tab-channel';
import { fakeBrowser } from '@/testing/fake-browser';

import {
  type GaveWay,
  givesWayTo,
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
});
