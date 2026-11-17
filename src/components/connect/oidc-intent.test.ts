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
  takeOidcBook,
  takeOidcIntent,
  takeOidcReconnect,
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

it('carries "Add someone" and the book across the trip, taken once', () => {
  seedProfile();
  setConnectForNewProfile(true);
  holdOidcIntent(BOOK);
  // The page load: memory is gone.
  endConnectFlow();
  const held = takeOidcIntent(true);
  expect(held).toEqual({ newPerson: true, grownUpFromKids: false, book: BOOK });
  expect(takeOidcIntent(true)).toBeNull();
  const settled = jest.fn();
  // No pass left with the trip: none waits, and nothing is settled later.
  expect(resumeOidcIntent(held!, settled)).toBe(false);
  expect(connectForNewProfile()).toBe(true);
  expect(takeOidcBook()).toEqual(BOOK);
  expect(takeOidcBook()).toBeUndefined();
  expect(settleOidcPass(true)).toBe(false);
  expect(settled).not.toHaveBeenCalled();
});

describe("a grown-up's pass through kids mode", () => {
  const leaveWithPass = () => {
    seedProfile({ kids: true });
    openAddSomeone();
    expect(kidsConnectAllowed()).toBe(true);
    holdOidcIntent();
    // The page load: memory is gone.
    endConnectFlow();
  };

  it("waits on the returned sign-in's finish, and comes back only with a session", () => {
    leaveWithPass();
    const settled = jest.fn();
    // Denied: the address alone (`/connect?oidc=1`) gives no pass back.
    expect(resumeOidcIntent(takeOidcIntent(true)!, settled)).toBe(true);
    expect(kidsConnectAllowed()).toBe(false);
    expect(settled).not.toHaveBeenCalled();
    // Allowed: the server answered with a session.
    expect(settleOidcPass(true)).toBe(true);
    expect(kidsConnectAllowed()).toBe(true);
    expect(settled).toHaveBeenCalledTimes(1);
    // Settled once.
    expect(settleOidcPass(true)).toBe(false);
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it('is not given when the finish fails (a trip abandoned at the provider, the address typed)', () => {
    leaveWithPass();
    const settled = jest.fn();
    expect(resumeOidcIntent(takeOidcIntent(true)!, settled)).toBe(true);
    expect(settleOidcPass(false)).toBe(true);
    expect(kidsConnectAllowed()).toBe(false);
    expect(settled).toHaveBeenCalledTimes(1);
    // Nor by a later answer.
    expect(settleOidcPass(true)).toBe(false);
    expect(kidsConnectAllowed()).toBe(false);
  });

  it('does not wait while kids mode would not let it through now', () => {
    leaveWithPass();
    // Denied: a grown-up is on the device now; the stored pass can't widen the rule.
    useProfiles.setState((s) => ({
      profiles: [...s.profiles, { id: 'g', name: 'Sam', connectionIds: ['srv.2'] }],
    }));
    const settled = jest.fn();
    expect(resumeOidcIntent(takeOidcIntent(true)!, settled)).toBe(false);
    expect(settleOidcPass(true)).toBe(false);
    expect(kidsConnectAllowed()).toBe(false);
  });

  it('is not given once a grown-up joined the device while the finish was on its way', () => {
    leaveWithPass();
    expect(resumeOidcIntent(takeOidcIntent(true)!, jest.fn())).toBe(true);
    useProfiles.setState((s) => ({
      profiles: [...s.profiles, { id: 'g', name: 'Sam', connectionIds: ['srv.2'] }],
    }));
    expect(settleOidcPass(true)).toBe(true);
    expect(kidsConnectAllowed()).toBe(false);
  });

  it('stops waiting when the flow is left', () => {
    leaveWithPass();
    const settled = jest.fn();
    expect(resumeOidcIntent(takeOidcIntent(true)!, settled)).toBe(true);
    dropOidcIntent();
    expect(settleOidcPass(true)).toBe(false);
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
  expect(takeOidcBook()).toBeUndefined();
});

// A reconnect's sign-in through single sign-on (fe#298): the in-memory hold is lost to the
// page load, so the connection it re-pairs goes with the intent, bound to its address.
describe('a reconnect across the trip', () => {
  const HOME = 'http://192.168.1.20:8080';
  const held = () => takeOidcIntent(true);

  it('is given to the finish for the address it signed in through, once', () => {
    holdOidcIntent(undefined, { server: HOME, id: 'srv-old.1' });
    const intent = held();
    expect(intent).toEqual({
      newPerson: false,
      grownUpFromKids: false,
      reconnect: { server: HOME, id: 'srv-old.1' },
    });
    resumeOidcIntent(intent!, jest.fn());
    // The same address written another way is the same server.
    expect(takeOidcReconnect(`${HOME}/`)).toBe('srv-old.1');
    expect(takeOidcReconnect(HOME)).toBeUndefined();
  });

  it('is not given for another server, and is spent all the same', () => {
    holdOidcIntent(undefined, { server: HOME, id: 'srv-old.1' });
    resumeOidcIntent(held()!, jest.fn());
    // Denied: the return is at another address than the sign-in step's.
    expect(takeOidcReconnect('http://192.168.1.21:8080')).toBeUndefined();
    expect(takeOidcReconnect(HOME)).toBeUndefined();
  });

  it('is not given past the stamp, once the flow is left, or from a malformed intent', () => {
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      holdOidcIntent(undefined, { server: HOME, id: 'srv-old.1' });
      // Denied: a return past the server's limit on a trip.
      clock.mockReturnValue(now + MAX_AGE_MS + 1);
      expect(held()).toBeNull();
    } finally {
      clock.mockRestore();
    }
    // Denied: the flow was left before the finish took it.
    holdOidcIntent(undefined, { server: HOME, id: 'srv-old.1' });
    resumeOidcIntent(held()!, jest.fn());
    dropOidcIntent();
    expect(takeOidcReconnect(HOME)).toBeUndefined();
    // Denied: a reconnect with no address, or no id, is none.
    for (const reconnect of [{ id: 'srv-old.1' }, { server: HOME }, { server: HOME, id: 7 }]) {
      store.set('audiosilo.oidcIntent', JSON.stringify({ at: Date.now(), reconnect }));
      expect(held()).toEqual({ newPerson: false, grownUpFromKids: false });
    }
  });
});
