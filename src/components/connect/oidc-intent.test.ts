import {
  connectForNewProfile,
  endConnectFlow,
  kidsConnectAllowed,
  openAddSomeone,
  setConnectForNewProfile,
} from '@/components/profiles/connect-intent';
import { resetProfilesForTests, useProfiles } from '@/stores/profiles';
import { seedProfile } from '@/testing/seed-profile';

import {
  dropOidcIntent,
  holdOidcIntent,
  MAX_AGE_MS,
  resumeOidcIntent,
  settleOidcPass,
  takeOidcIntent,
  takeOidcResumed,
} from './oidc-intent';

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));

// A single sign-on's trip to the provider is a page load (fe#310): the tab's storage is all
// that carries the flow's intent across it.
const store = new Map<string, string>();
beforeAll(() => {
  Object.defineProperty(globalThis, 'sessionStorage', {
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
    configurable: true,
  });
});
afterAll(() => {
  delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
});
beforeEach(() => store.clear());
afterEach(() => {
  resetProfilesForTests();
  endConnectFlow();
  dropOidcIntent();
});

const BOOK = { libraryId: 3, path: 'Austen/Emma' };
const HOME = 'http://192.168.1.20:8080';

it('carries "Add someone" and the book across the trip, taken once', () => {
  seedProfile();
  setConnectForNewProfile(true);
  holdOidcIntent(BOOK);
  // The page load: memory is gone.
  endConnectFlow();
  const held = takeOidcIntent(true);
  expect(held).toEqual({
    newPerson: true,
    grownUpFromKids: false,
    book: BOOK,
    tag: expect.stringMatching(/^[0-9a-f]{64}$/),
  });
  expect(takeOidcIntent(true)).toBeNull();
  const settled = jest.fn();
  // No pass left with the trip: none waits, and nothing is settled later.
  expect(resumeOidcIntent(held!, settled)).toBe(false);
  expect(connectForNewProfile()).toBe(true);
  expect(takeOidcResumed(HOME).book).toEqual(BOOK);
  expect(takeOidcResumed(HOME).book).toBeUndefined();
  expect(settleOidcPass({ intent: held!.tag })).toBe('none');
  expect(settled).not.toHaveBeenCalled();
});

describe("a grown-up's pass through kids mode", () => {
  // The trip's tag (`holdOidcIntent`'s answer, the start URL's `intent`).
  const leaveWithPass = (): string => {
    seedProfile({ kids: true });
    openAddSomeone();
    expect(kidsConnectAllowed()).toBe(true);
    const tag = holdOidcIntent();
    expect(tag).toMatch(/^[0-9a-f]{64}$/);
    // The page load: memory is gone.
    endConnectFlow();
    return tag!;
  };

  it("waits on the returned sign-in's finish, and comes back only with its own trip's tag", () => {
    const tag = leaveWithPass();
    const settled = jest.fn();
    // Denied: the address alone (`/connect?oidc=1`) gives no pass back.
    expect(resumeOidcIntent(takeOidcIntent(true)!, settled)).toBe(true);
    expect(kidsConnectAllowed()).toBe(false);
    expect(settled).not.toHaveBeenCalled();
    // Allowed: the server answered with a session echoing this trip's tag.
    expect(settleOidcPass({ intent: tag })).toBe('given');
    expect(kidsConnectAllowed()).toBe(true);
    expect(settled).toHaveBeenCalledTimes(1);
    // Settled once.
    expect(settleOidcPass({ intent: tag })).toBe('none');
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it('is not given when the finish fails (a trip abandoned at the provider, the address typed)', () => {
    const tag = leaveWithPass();
    const settled = jest.fn();
    expect(resumeOidcIntent(takeOidcIntent(true)!, settled)).toBe(true);
    expect(settleOidcPass(null)).toBe('refused');
    expect(kidsConnectAllowed()).toBe(false);
    expect(settled).toHaveBeenCalledTimes(1);
    // Nor by a later answer.
    expect(settleOidcPass({ intent: tag })).toBe('none');
    expect(kidsConnectAllowed()).toBe(false);
  });

  // audiosilo#202: with the provider still signed in, the server's start URL typed in this tab
  // finishes a sign-in too. Its session never carries this trip's tag.
  it.each([
    ['no tag (the start URL typed, a tag spent before, or an older server)', {}],
    ["another trip's tag", { intent: 'cd'.repeat(32) }],
    ['an empty tag', { intent: '' }],
  ])('is not given for a session with %s', (_, session) => {
    leaveWithPass();
    const settled = jest.fn();
    expect(resumeOidcIntent(takeOidcIntent(true)!, settled)).toBe(true);
    expect(settleOidcPass(session)).toBe('refused');
    expect(kidsConnectAllowed()).toBe(false);
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it('is not given when the intent holds no tag (an older build, or one that is no tag)', () => {
    seedProfile({ kids: true });
    for (const tag of [undefined, 'ab'.repeat(31), 'AB'.repeat(32), 42]) {
      store.set(
        'audiosilo.oidcIntent',
        JSON.stringify({ at: Date.now(), grownUpFromKids: true, tag }),
      );
      const held = takeOidcIntent(true)!;
      expect(held.tag).toBeUndefined();
      expect(resumeOidcIntent(held, jest.fn())).toBe(true);
      // Even a session echoing the stored value gets nothing.
      expect(settleOidcPass({ intent: typeof tag === 'string' ? tag : undefined })).toBe('refused');
      expect(kidsConnectAllowed()).toBe(false);
    }
  });

  it('makes a new tag for every trip', () => {
    const first = leaveWithPass();
    expect(takeOidcIntent(true)?.tag).toBe(first);
    const second = leaveWithPass();
    expect(second).not.toBe(first);
  });

  it('sends no tag when the tab keeps nothing', () => {
    seedProfile();
    const full = jest.spyOn(sessionStorage, 'setItem').mockImplementation(() => {
      throw new Error('full');
    });
    try {
      expect(holdOidcIntent()).toBeUndefined();
    } finally {
      full.mockRestore();
    }
  });

  it('does not wait while kids mode would not let it through now', () => {
    leaveWithPass();
    // Denied: a grown-up is on the device now; the stored pass can't widen the rule.
    useProfiles.setState((s) => ({
      profiles: [...s.profiles, { id: 'g', name: 'Sam', connectionIds: ['srv.2'] }],
    }));
    const settled = jest.fn();
    const held = takeOidcIntent(true)!;
    expect(resumeOidcIntent(held, settled)).toBe(false);
    expect(settleOidcPass({ intent: held.tag })).toBe('none');
    expect(kidsConnectAllowed()).toBe(false);
  });

  it('is not given once a grown-up joined the device while the finish was on its way', () => {
    const tag = leaveWithPass();
    expect(resumeOidcIntent(takeOidcIntent(true)!, jest.fn())).toBe(true);
    useProfiles.setState((s) => ({
      profiles: [...s.profiles, { id: 'g', name: 'Sam', connectionIds: ['srv.2'] }],
    }));
    expect(settleOidcPass({ intent: tag })).toBe('given');
    expect(kidsConnectAllowed()).toBe(false);
  });

  it('stops waiting when the flow is left', () => {
    const tag = leaveWithPass();
    const settled = jest.fn();
    expect(resumeOidcIntent(takeOidcIntent(true)!, settled)).toBe(true);
    dropOidcIntent();
    expect(settleOidcPass({ intent: tag })).toBe('none');
    expect(kidsConnectAllowed()).toBe(false);
    expect(settled).not.toHaveBeenCalled();
  });
});

it('drops what was held when this load is not the return, and reads nothing it cannot parse', () => {
  holdOidcIntent(BOOK);
  expect(takeOidcIntent(false)).toBeNull();
  expect(takeOidcIntent(true)).toBeNull();
  store.set('audiosilo.oidcIntent', '{not json');
  expect(takeOidcIntent(true)).toBeNull();
  // A book that is no book is left out; the rest stands.
  store.set(
    'audiosilo.oidcIntent',
    JSON.stringify({ at: Date.now(), newPerson: true, book: { book: 'x', path: 'a' } }),
  );
  expect(takeOidcIntent(true)).toEqual({ newPerson: true, grownUpFromKids: false });
});

it("gives back no pass left by a trip abandoned at the provider: too old, or the flow's gone", () => {
  seedProfile({ kids: true });
  openAddSomeone();
  const now = Date.now();
  const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
  try {
    holdOidcIntent();
    // Denied: a page load of `/connect?oidc=1` past the server's limit on a trip.
    clock.mockReturnValue(now + MAX_AGE_MS + 1);
    expect(takeOidcIntent(true)).toBeNull();
    // Denied: one with no stamp (not written by this build).
    store.set('audiosilo.oidcIntent', JSON.stringify({ grownUpFromKids: true }));
    expect(takeOidcIntent(true)).toBeNull();
    // Allowed: within the limit.
    clock.mockReturnValue(now);
    holdOidcIntent();
    clock.mockReturnValue(now + MAX_AGE_MS);
    expect(takeOidcIntent(true)?.grownUpFromKids).toBe(true);
  } finally {
    clock.mockRestore();
  }
  // Denied: the flow was left (the page restored from the cache, then left) before any return.
  holdOidcIntent();
  resumeOidcIntent({ newPerson: false, grownUpFromKids: false, book: BOOK }, jest.fn());
  dropOidcIntent();
  expect(store.size).toBe(0);
  expect(takeOidcResumed(HOME)).toEqual({});
});

// A reconnect's sign-in through single sign-on (fe#298): the in-memory hold is lost to the
// page load, so the connection it re-pairs goes with the intent, bound to its address.
describe('a reconnect across the trip', () => {
  const held = () => takeOidcIntent(true);
  const reconnectOf = (origin: string) => takeOidcResumed(origin).reconnectId;

  it('is given to the finish for the address it signed in through, once', () => {
    // The server as the connection stored it: the same origin as the page's, written another
    // way, is the same server, by the rule that offered single sign-on there (`onlyOwnServer`).
    const server = 'HTTP://192.168.1.20:8080/';
    holdOidcIntent(undefined, { server, reconnectId: 'srv-old.1' });
    const intent = held();
    expect(intent).toEqual({
      newPerson: false,
      grownUpFromKids: false,
      reconnect: { server, reconnectId: 'srv-old.1' },
      tag: expect.any(String),
    });
    resumeOidcIntent(intent!, jest.fn());
    expect(reconnectOf(HOME)).toBe('srv-old.1');
    expect(reconnectOf(HOME)).toBeUndefined();
  });

  it('is not given for another server, and is spent all the same', () => {
    holdOidcIntent(undefined, { server: HOME, reconnectId: 'srv-old.1' });
    resumeOidcIntent(held()!, jest.fn());
    // Denied: the return is at another address than the sign-in step's.
    expect(reconnectOf('http://192.168.1.21:8080')).toBeUndefined();
    expect(reconnectOf(HOME)).toBeUndefined();
  });

  it('is not given past the stamp, once the flow is left, or from a malformed intent', () => {
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      holdOidcIntent(undefined, { server: HOME, reconnectId: 'srv-old.1' });
      // Denied: a return past the server's limit on a trip.
      clock.mockReturnValue(now + MAX_AGE_MS + 1);
      expect(held()).toBeNull();
    } finally {
      clock.mockRestore();
    }
    // Denied: the flow was left before the finish took it.
    holdOidcIntent(undefined, { server: HOME, reconnectId: 'srv-old.1' });
    resumeOidcIntent(held()!, jest.fn());
    dropOidcIntent();
    expect(reconnectOf(HOME)).toBeUndefined();
    // Denied: a reconnect with no address, or no id, is none.
    for (const reconnect of [
      { reconnectId: 'srv-old.1' },
      { server: HOME },
      { server: HOME, reconnectId: 7 },
    ]) {
      store.set('audiosilo.oidcIntent', JSON.stringify({ at: Date.now(), reconnect }));
      expect(held()).toEqual({ newPerson: false, grownUpFromKids: false });
    }
  });
});
