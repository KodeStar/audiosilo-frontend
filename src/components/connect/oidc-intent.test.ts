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
  takeOidcBook,
  takeOidcIntent,
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
  resumeOidcIntent(held!);
  expect(connectForNewProfile()).toBe(true);
  expect(takeOidcBook()).toEqual(BOOK);
  expect(takeOidcBook()).toBeUndefined();
});

it("puts a grown-up's pass through kids mode back only while kids mode would let it through", () => {
  seedProfile({ kids: true });
  openAddSomeone();
  expect(kidsConnectAllowed()).toBe(true);
  holdOidcIntent();
  endConnectFlow();
  // Allowed: a kid-only device, as when the pass was given.
  resumeOidcIntent(takeOidcIntent(true)!);
  expect(kidsConnectAllowed()).toBe(true);
  endConnectFlow();
  // Denied: a grown-up is on the device now; the stored pass can't widen the rule.
  useProfiles.setState((s) => ({
    profiles: [...s.profiles, { id: 'g', name: 'Sam', connectionIds: ['srv.2'] }],
  }));
  resumeOidcIntent({ newPerson: true, grownUpFromKids: true });
  expect(kidsConnectAllowed()).toBe(false);
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
  resumeOidcIntent({ newPerson: false, grownUpFromKids: false, book: BOOK });
  dropOidcIntent();
  expect(store.size).toBe(0);
  expect(takeOidcBook()).toBeUndefined();
});
