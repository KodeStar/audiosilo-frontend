import { Platform } from 'react-native';

import type { User } from '@/api/types';
import { CONNECTIONS_KEY, PROFILES_KEY } from '@/lib/storage-keys';
import { tabChannel } from '@/lib/tab-channel';
import { fakeBrowser, type FakeTab, sleep, tabStorage, until } from '@/testing/fake-browser';
import { fakeWebLocks } from '@/testing/fake-web-locks';

/**
 * The web player's tabs share the stored connections, tokens and profiles, each holding its
 * own copy in memory. Two tabs here are two copies of the session and profiles stores
 * (`jest.isolateModules`) over one fake browser: its `localStorage` holds the documents and
 * the tokens (as the web keeps them), and its writes and channel messages reach the other
 * tabs.
 */

type Session = typeof import('@/stores/session');
type Profiles = typeof import('@/stores/profiles');
type Tab = Session & { profiles: Profiles; env: FakeTab };

const REMOVAL_CHANNEL = 'audiosilo-connection-removed';

/** A tab's secure-store reads can be held (`gate.wait`): the value is read at the call and
 * handed back once the gate opens, as a read that started before another tab's write. */
type Gate = { wait: Promise<void> | null };

function openTab(browser: ReturnType<typeof fakeBrowser>, gate: Gate = { wait: null }): Tab {
  const env = browser.tab();
  let session!: Session;
  let profiles!: Profiles;
  jest.isolateModules(() => {
    jest.doMock('@/lib/storage', () => tabStorage(env.localStorage));
    jest.doMock('@/lib/secure-store', () => ({
      getSecure: async (key: string) => {
        const value = env.localStorage.getItem(key);
        if (gate.wait) await gate.wait;
        return value;
      },
      setSecure: async (key: string, value: string) => env.localStorage.setItem(key, value),
      deleteSecure: async (key: string) => env.localStorage.removeItem(key),
    }));
    /* eslint-disable @typescript-eslint/no-require-imports */
    session = require('@/stores/session') as Session;
    profiles = require('@/stores/profiles') as Profiles;
    /* eslint-enable @typescript-eslint/no-require-imports */
  });
  session.setTabsForTests({ channel: asWeb(() => tabChannel(REMOVAL_CHANNEL, env)), env });
  return { ...session, profiles, env };
}

/** Run `fn` as on the web, where a tab channel is made; the rest of the store runs as on the
 * device the tests run as. */
function asWeb<T>(fn: () => T): T {
  const os = Platform.OS;
  Platform.OS = 'web';
  try {
    return fn();
  } finally {
    Platform.OS = os;
  }
}

const mkUser = (id: number, name: string): User => ({
  id,
  username: name,
  role: 'user',
  disabled: false,
  has_password: false,
  has_recovery: false,
});

const settle = () => new Promise((r) => setTimeout(r, 10));

const signIn = (tab: Tab, userId: number, name: string, token: string, serverId = 'srv') =>
  tab.useSession.getState().setSession({
    serverUrl: `https://${serverId}`,
    serverId,
    token,
    user: mkUser(userId, name),
  });

/** Tabs A and B, both signed in to `alex` (made the default) and `sam`. */
async function twoTabs(browser = fakeBrowser()) {
  const b = openTab(browser);
  await b.useSession.getState().hydrate();
  const sam = await signIn(b, 2, 'sam', 'ts');
  const alex = await signIn(b, 1, 'alex', 'ta');
  const a = openTab(browser);
  await a.useSession.getState().hydrate();
  expect(a.useSession.getState().defaultConnectionId).toBe(alex);
  return { a, b, alex, sam, browser };
}

/** Keep the words on the channel from reaching `tab` until the function returned is called
 * (its `storage` events still arrive): a tab whose main thread was held while another tab
 * removed a connection, which hears the stored list before the word. */
type WordsChannel = NonNullable<NonNullable<Parameters<Session['setTabsForTests']>[0]>['channel']>;
function holdWords(tab: Tab): () => void {
  let release!: () => void;
  const words = new Promise<void>((r) => (release = r));
  const real = asWeb(() => tabChannel(REMOVAL_CHANNEL, tab.env)) as WordsChannel;
  tab.setTabsForTests({
    channel: {
      post: real.post,
      subscribe: (listener) => real.subscribe((m) => void words.then(() => listener(m))),
    },
    env: tab.env,
  });
  return release;
}

/** The stored profiles document. */
const storedDoc = (browser: ReturnType<typeof fakeBrowser>) =>
  JSON.parse(browser.data.get(PROFILES_KEY) ?? 'null') as import('@/stores/profiles').ProfilesDoc;
/** The stored connections' ids. */
const storedIds = (browser: ReturnType<typeof fakeBrowser>) =>
  (JSON.parse(browser.data.get(CONNECTIONS_KEY) ?? '[]') as { id: string }[]).map((c) => c.id);

describe('a connection removed in another tab (web)', () => {
  it('is forgotten here too: the list, the default, and every removal cleanup', async () => {
    const { a, b, alex, sam } = await twoTabs();
    const order: string[] = [];
    a.onConnectionRemovedInOtherTab((id) => void order.push(`step ${id}`));
    a.onConnectionRemoved((id) => void order.push(`cleanup ${id}`));
    await b.useSession.getState().removeConnection(alex);
    await settle();
    const s = a.useSession.getState();
    expect(s.connections.map((c) => c.id)).toEqual([sam]);
    // The screens follow the default the removing tab moved to.
    expect(s.defaultConnectionId).toBe(sam);
    expect(s.user?.username).toBe('sam');
    // The player stops before the purges run (`removed-in-other-tab.ts`): at the stored list,
    // and asked again at the word (nothing plays through it by then).
    expect(order).toEqual([`step ${alex}`, `step ${alex}`, `cleanup ${alex}`]);
  });

  it('the last connection: this tab is signed out too', async () => {
    const { a, b, alex, sam } = await twoTabs();
    await b.useSession.getState().removeConnection(sam);
    await b.useSession.getState().removeConnection(alex);
    await settle();
    expect(a.useSession.getState().connections).toEqual([]);
    expect(a.useSession.getState().status).toBe('unauthenticated');
  });

  it('is not forgotten here once signed in again before the word arrived', async () => {
    const { a, b, alex, browser } = await twoTabs();
    const cleanup = jest.fn();
    a.onConnectionRemoved(cleanup);
    const release = browser.hold();
    await b.useSession.getState().removeConnection(alex);
    await signIn(b, 1, 'alex', 'ta2');
    release();
    await settle();
    expect(a.useSession.getState().connections.map((c) => c.id)).toContain(alex);
    expect(cleanup).not.toHaveBeenCalled();
  });

  // The stop waits its turn into the outbox (a lock the tabs share): a sign-in to the same
  // account meanwhile, and what it stored since (a download, its listening), is not purged.
  it('purges nothing once signed in again while this tab stopped playing', async () => {
    const { a, b, alex } = await twoTabs();
    const cleanup = jest.fn();
    a.onConnectionRemoved(cleanup);
    a.onConnectionRemovedInOtherTab(async () => {
      await signIn(b, 1, 'alex', 'ta2');
    });
    await b.useSession.getState().removeConnection(alex);
    await settle();
    expect(cleanup).not.toHaveBeenCalled();
  });

  // The web build's static render imports the store in Node, where an open
  // `BroadcastChannel` keeps the export's process from exiting.
  it('opens the channel at the launch (hydrate), never at import', async () => {
    const opened: string[] = [];
    class Channel {
      constructor(name: string) {
        opened.push(name);
      }
      addEventListener() {}
      removeEventListener() {}
      postMessage() {}
    }
    const globals = globalThis as { BroadcastChannel?: unknown };
    const real = globals.BroadcastChannel;
    const os = Platform.OS;
    globals.BroadcastChannel = Channel;
    Platform.OS = 'web';
    try {
      let tab!: Session;
      jest.isolateModules(() => {
        /* eslint-disable-next-line @typescript-eslint/no-require-imports */
        tab = require('@/stores/session') as Session;
      });
      expect(opened).toEqual([]);
      await tab.useSession.getState().hydrate();
      expect(opened).toEqual([REMOVAL_CHANNEL]);
      // Once: a later hydrate (a retry) listens on the same channel.
      await tab.useSession.getState().hydrate();
      expect(opened).toEqual([REMOVAL_CHANNEL]);
    } finally {
      Platform.OS = os;
      globals.BroadcastChannel = real;
    }
  });

  // A tab held while another tab removed the connection it plays through (a busy main
  // thread, a frozen background tab) hears the stored list before the word. It stops playing
  // then, not at the word: the screens it shows leave the connection with the list, and the
  // playing book must not stay on them through a connection it no longer holds. The list
  // goes first, so the stop's saves never go out with the revoked token; the purges wait for
  // the word (a retirement's moves the person first).
  it('a tab playing through it stops once the stored list drops it, before the word', async () => {
    const { a, b, alex, sam } = await twoTabs();
    const releaseWords = holdWords(a);
    let playing = true;
    const listAtStop: string[][] = [];
    const order: string[] = [];
    a.onConnectionRemovedInOtherTab((id) => {
      if (!playing || id !== alex) return;
      playing = false;
      listAtStop.push(a.useSession.getState().connections.map((c) => c.id));
      order.push('stop');
    });
    a.onConnectionRemoved((id) => void order.push(`cleanup ${id}`));
    await b.useSession.getState().removeConnection(alex);
    await until(() => !playing, 'the stop');
    expect(listAtStop).toEqual([[sam]]);
    expect(order).toEqual(['stop']);
    releaseWords();
    await until(() => order.length === 2, 'the cleanups');
    expect(order).toEqual(['stop', `cleanup ${alex}`]);
  });

  it('stops once when the stored list and the word arrive together', async () => {
    const { a, b, alex } = await twoTabs();
    const step = jest.fn(async () => {
      await sleep(20);
    });
    const cleanup = jest.fn();
    a.onConnectionRemovedInOtherTab(step);
    a.onConnectionRemoved(cleanup);
    await b.useSession.getState().removeConnection(alex);
    await until(() => cleanup.mock.calls.length > 0, 'the cleanups');
    expect(step).toHaveBeenCalledTimes(1);
  });

  it('the removing tab runs its own cleanups once, not again on its own word', async () => {
    const { b, alex } = await twoTabs();
    const cleanup = jest.fn();
    b.onConnectionRemoved(cleanup);
    await b.useSession.getState().removeConnection(alex);
    await settle();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});

describe('the stored sign-ins and people, followed across tabs (web)', () => {
  /** `twoTabs` with both tabs' profiles read. */
  async function twoTabsWithPeople(browser = fakeBrowser()) {
    const tabs = await twoTabs(browser);
    for (const t of [tabs.a, tabs.b]) await t.profiles.useProfiles.getState().hydrate();
    await settle();
    return tabs;
  }

  it('a person added in another tab keeps their name, PIN and kids settings through a removal this tab is told of', async () => {
    const { a, b, sam, browser } = await twoTabsWithPeople();
    const jo = await signIn(a, 3, 'jo', 'tj', 'other');
    const person = a.profiles.placeConnection(jo, { newProfile: true, name: 'Jo' })!;
    a.profiles.setProfileHasPin(person, true);
    a.profiles.setProfileKids(person, { bedtime: '18:00' });
    await settle();
    // A removes sam; B is told, drops it, and runs its cleanups.
    await a.useSession.getState().removeConnection(sam);
    await settle();
    const want = {
      id: person,
      name: 'Jo',
      connectionIds: [jo],
      hasPin: true,
      kids: { bedtime: '18:00' },
    };
    expect(storedDoc(browser).profiles).toContainEqual(want);
    expect(b.profiles.useProfiles.getState().profiles).toContainEqual(want);
    expect(storedIds(browser)).toContain(jo);
    expect(storedIds(browser)).not.toContain(sam);
    expect(b.useSession.getState().connections.map((c) => c.id)).toContain(jo);
  });

  it("a tab that has not heard another tab's writes yet never writes its older copy over them", async () => {
    const { a, b, alex, browser } = await twoTabsWithPeople();
    const release = browser.hold();
    const jo = await signIn(a, 3, 'jo', 'tj', 'other');
    const person = a.profiles.placeConnection(jo, { newProfile: true, name: 'Jo' })!;
    a.profiles.setProfileHasPin(person, true);
    await until(
      () => storedDoc(browser).profiles.some((p) => p.id === person && p.hasPin === true),
      "A's people written",
    );
    // B, told of none of it yet, changes the list and its own person.
    await b.useSession.getState().setConnectionUser(alex, mkUser(1, 'alexander'));
    const mine = b.profiles.activeProfile()!.id;
    b.profiles.renameProfile(mine, 'Alexander');
    await settle();
    expect(storedIds(browser)).toEqual(expect.arrayContaining([jo, alex]));
    const doc = storedDoc(browser);
    expect(doc.profiles.find((p) => p.id === person)).toMatchObject({ name: 'Jo', hasPin: true });
    expect(doc.profiles.find((p) => p.id === mine)?.name).toBe('Alexander');
    // B's own person stays the one listening in B.
    expect(b.profiles.useProfiles.getState().activeProfileId).toBe(mine);
    release();
    await settle();
    expect(b.profiles.useProfiles.getState().profiles.find((p) => p.id === person)?.name).toBe(
      'Jo',
    );
  });

  // The other tab's document can be read before its list is heard (a direct read sees the
  // write before the `storage` event arrives): a reconcile of this tab's own, made again
  // over that document, must not drop the people whose connections it has not heard of yet.
  it("a reconcile of its own made over another tab's newer people keeps them", async () => {
    const { a, b, sam, browser } = await twoTabsWithPeople();
    const release = browser.hold();
    const jo = await signIn(a, 3, 'jo', 'tj', 'other');
    const person = a.profiles.placeConnection(jo, { newProfile: true, name: 'Jo' })!;
    await until(
      () => storedDoc(browser).profiles.some((p) => p.id === person),
      "A's people written",
    );
    // B, told of none of it yet, flags one of its own (in memory: no list write first).
    b.useSession.getState().markNeedsReconnect(sam, 'auth');
    await settle();
    expect(storedDoc(browser).profiles.find((p) => p.id === person)).toMatchObject({
      name: 'Jo',
      connectionIds: [jo],
    });
    release();
    await settle();
    expect(b.profiles.profileOf(jo)?.id).toBe(person);
  });

  it("takes another tab's people as they are written, its own person still listening", async () => {
    const { a, b } = await twoTabsWithPeople();
    const mine = b.profiles.activeProfile()!.id;
    const jo = await signIn(a, 3, 'jo', 'tj', 'other');
    const person = a.profiles.placeConnection(jo, { newProfile: true, name: 'Jo' })!;
    await settle();
    a.profiles.renameProfile(person, 'Joanna');
    await settle();
    expect(b.profiles.useProfiles.getState().profiles.find((p) => p.id === person)?.name).toBe(
      'Joanna',
    );
    // A switched to Jo; B's listener is still B's.
    expect(a.profiles.useProfiles.getState().activeProfileId).toBe(person);
    expect(b.profiles.useProfiles.getState().activeProfileId).toBe(mine);
  });

  // The server was reset: the same address, a new server id. A sign-in in tab A retires the
  // person's dead identity; tab B moves the person to the new one, as A did.
  async function retireInA(a: Tab) {
    return a.useSession.getState().setSession({
      serverUrl: 'https://srv',
      serverId: 'srv-new',
      token: 'tn',
      user: mkUser(1, 'alex'),
      retire: ['srv.1'],
    });
  }

  it('a retirement in another tab moves the person to the new connection here, and purges the old', async () => {
    const { a, b, alex, browser } = await twoTabsWithPeople();
    const person = b.profiles.profileOf(alex)!.id;
    b.profiles.renameProfile(person, 'Alex');
    b.profiles.setProfileHasPin(person, true);
    await settle();
    const cleanup = jest.fn();
    b.onConnectionRemoved(cleanup);
    const fresh = await retireInA(a);
    await settle();
    const ids = b.useSession.getState().connections.map((c) => c.id);
    expect(ids).toContain(fresh);
    expect(ids).not.toContain(alex);
    expect(b.profiles.profileOf(fresh)).toMatchObject({ id: person, name: 'Alex', hasPin: true });
    expect(b.profiles.useProfiles.getState().activeProfileId).toBe(person);
    expect(storedDoc(browser).profiles.find((p) => p.id === person)).toMatchObject({
      name: 'Alex',
      hasPin: true,
      connectionIds: [fresh],
    });
    expect(cleanup).toHaveBeenCalledWith(alex);
  });

  // A tab still on an earlier build hears only `removed`, and would drop the person with it.
  it('a retirement is never told as a removal', async () => {
    const { a, browser } = await twoTabsWithPeople();
    const heard: unknown[] = [];
    asWeb(() => tabChannel(REMOVAL_CHANNEL, browser.tab()))?.subscribe((m) => void heard.push(m));
    const fresh = await retireInA(a);
    await settle();
    expect(heard).toEqual([{ retired: 'srv.1', replacedBy: fresh }]);
  });

  // The told tab moves the person itself (the word names the new connection): the retiring
  // tab's document may land after the list, or (its people not read) never.
  it("a retirement told before the retiring tab's people are written still keeps the person", async () => {
    const browser = fakeBrowser();
    const b = openTab(browser);
    await b.useSession.getState().hydrate();
    await signIn(b, 2, 'sam', 'ts');
    const alex = await signIn(b, 1, 'alex', 'ta');
    await b.profiles.useProfiles.getState().hydrate();
    const person = b.profiles.profileOf(alex)!.id;
    b.profiles.setProfileHasPin(person, true);
    await settle();
    const a = openTab(browser); // its people never read: it writes no document
    await a.useSession.getState().hydrate();
    const fresh = await retireInA(a);
    await settle();
    expect(b.profiles.profileOf(fresh)).toMatchObject({ id: person, hasPin: true });
    expect(storedDoc(browser).profiles.find((p) => p.id === person)?.connectionIds).toEqual([
      fresh,
    ]);
  });

  it('a removal heard while this tab still reads its sign-ins is not undone by that read', async () => {
    const browser = fakeBrowser();
    const b = openTab(browser);
    await b.useSession.getState().hydrate();
    const sam = await signIn(b, 2, 'sam', 'ts');
    const alex = await signIn(b, 1, 'alex', 'ta');
    let open!: () => void;
    const gate: Gate = { wait: new Promise<void>((r) => (open = r)) };
    const a = openTab(browser, gate);
    const hydrating = a.useSession.getState().hydrate();
    await settle(); // A has read alex's token, and holds it
    gate.wait = null;
    await b.useSession.getState().removeConnection(alex);
    await settle(); // A heard of the removal, mid-hydrate
    open();
    await hydrating;
    await settle();
    expect(a.useSession.getState().connections.map((c) => c.id)).toEqual([sam]);
  });

  // A set edited in place leaves the stored list as it was: only the sets' own write tells
  // this tab (fe#295: one item for every origin's set).
  it("another tab's edited proxy headers are the ones this tab sends", async () => {
    const { a, b } = await twoTabs();
    const ORIGIN = 'https://proxy.example';
    const set = (value: string) => ({ origin: ORIGIN, headers: [{ name: 'X-Proxy-Auth', value }] });
    await b.useSession.getState().setProxySet(ORIGIN, set('one'));
    await settle();
    expect(a.useSession.getState().proxySets[ORIGIN]).toEqual(set('one'));
    await b.useSession.getState().setProxySet(ORIGIN, set('two'));
    await settle();
    expect(a.useSession.getState().proxySets[ORIGIN]).toEqual(set('two'));
    await b.useSession.getState().setProxySet(ORIGIN, null);
    await settle();
    expect(a.useSession.getState().proxySets).toEqual({});
  });

  // The proxy headers rule is read against the list as stored (fe#295): a full account another
  // tab signed in through the address, which this tab has not heard of yet, still keeps a kid's
  // sign-in here from replacing the set they share.
  it("a kid's sign-in never replaces a set a full account signed in through in another tab", async () => {
    const browser = fakeBrowser();
    const a = openTab(browser);
    const b = openTab(browser);
    await a.useSession.getState().hydrate();
    await b.useSession.getState().hydrate();
    const ORIGIN = 'https://srv';
    const set = (value: string) => ({ origin: ORIGIN, headers: [{ name: 'X-Proxy-Auth', value }] });
    await b.useSession.getState().setProxySet(ORIGIN, set('kept'));
    await settle();
    expect(a.useSession.getState().proxySets[ORIGIN]).toEqual(set('kept'));
    const release = browser.hold();
    await signIn(b, 1, 'alex', 'ta');
    // This tab has not heard of alex yet.
    expect(a.useSession.getState().connections).toEqual([]);
    await a.useSession.getState().setSession({
      serverUrl: ORIGIN,
      serverId: 'srv',
      token: 'tk',
      user: { ...mkUser(12, 'evie'), member_kind: 'kid' },
      proxyHeaders: set('typed'),
    });
    release();
    await settle();
    expect(a.useSession.getState().proxySets[ORIGIN]).toEqual(set('kept'));
    expect(b.useSession.getState().proxySets[ORIGIN]).toEqual(set('kept'));
  });

  // The sets as stored, too: a set another tab kept for the address leaves the list as it was,
  // so only the sets' own read tells a tab that has not heard of it yet. A kid's sign-in here
  // must not take the address as having none and write its own over it.
  it("a kid's sign-in never writes over a set another tab kept meanwhile", async () => {
    const { a, b, browser } = await twoTabs();
    const ORIGIN = 'https://srv';
    const set = (value: string) => ({ origin: ORIGIN, headers: [{ name: 'X-Proxy-Auth', value }] });
    const release = browser.hold();
    await b.useSession.getState().setProxySet(ORIGIN, set('kept'));
    // This tab has not heard of the set yet.
    expect(a.useSession.getState().proxySets).toEqual({});
    await a.useSession.getState().setSession(
      {
        serverUrl: ORIGIN,
        serverId: 'srv',
        token: 'tk',
        user: { ...mkUser(12, 'evie'), member_kind: 'kid' },
        proxyHeaders: set('typed'),
      },
      { makeDefault: false },
    );
    release();
    await settle();
    expect(a.useSession.getState().proxySets[ORIGIN]).toEqual(set('kept'));
    expect(b.useSession.getState().proxySets[ORIGIN]).toEqual(set('kept'));
  });

  // A tab of an earlier build (the bundle before fe#295) keeps a set for its connection
  // after this tab launched: its mark in the list is one this tab never wrote. This tab's
  // writes of the list keep it, or the item behind it would never be moved.
  it("keeps a mark an earlier build's tab wrote, through this tab's writes of the list", async () => {
    const { a, b, alex } = await twoTabs();
    type Stored = { id: string; hasProxyHeaders?: true };
    const stored = () => JSON.parse(b.env.localStorage.getItem(CONNECTIONS_KEY)!) as Stored[];
    b.env.localStorage.setItem(
      `audiosilo.proxy-headers.${alex}`,
      JSON.stringify({ origin: 'https://srv', headers: [{ name: 'X-Proxy', value: 'one' }] }),
    );
    b.env.localStorage.setItem(
      CONNECTIONS_KEY,
      JSON.stringify(stored().map((m) => (m.id === alex ? { ...m, hasProxyHeaders: true } : m))),
    );
    await settle();
    await a.useSession.getState().setConnectionUser(alex, mkUser(1, 'alexander'));
    expect(stored().find((m) => m.id === alex)?.hasProxyHeaders).toBe(true);
    expect(a.useSession.getState().connections.find((c) => c.id === alex)).not.toHaveProperty(
      'hasProxyHeaders',
    );
  });

  // A tab whose move of an earlier build's set could not be written uses the set from where
  // it is (fe#295): another tab's write of the list must not take it from this tab.
  it("keeps a set used in place from an earlier build's item through another tab's write", async () => {
    const browser = fakeBrowser();
    const { b, alex } = await twoTabs(browser);
    type Stored = { id: string; hasProxyHeaders?: true };
    const stored = () => JSON.parse(b.env.localStorage.getItem(CONNECTIONS_KEY)!) as Stored[];
    const set = { origin: 'https://srv', headers: [{ name: 'X-Proxy', value: 'one' }] };
    b.env.localStorage.setItem(`audiosilo.proxy-headers.${alex}`, JSON.stringify(set));
    b.env.localStorage.setItem(
      CONNECTIONS_KEY,
      JSON.stringify(stored().map((m) => (m.id === alex ? { ...m, hasProxyHeaders: true } : m))),
    );
    const c = openTab(browser);
    const write = c.env.localStorage.setItem;
    c.env.localStorage.setItem = (key, value) => {
      if (key === 'audiosilo.proxy-sets') throw new Error('quota');
      write(key, value);
    };
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await c.useSession.getState().hydrate();
      expect(c.useSession.getState().proxySets).toEqual({ [set.origin]: set });
      await b.useSession.getState().setConnectionUser(alex, mkUser(1, 'alexander'));
      await settle();
      expect(c.useSession.getState().connections.find((x) => x.id === alex)?.user.username).toBe(
        'alexander',
      );
      expect(c.useSession.getState().proxySets).toEqual({ [set.origin]: set });
    } finally {
      warn.mockRestore();
    }
  });

  // Each tab builds the first document from the same list at once: the second to write finds
  // the first's people, and someone is still listening there.
  it('two tabs making the first people at once both have someone listening', async () => {
    const { a, b, alex, browser } = await twoTabs();
    await Promise.all([
      a.profiles.useProfiles.getState().hydrate(),
      b.profiles.useProfiles.getState().hydrate(),
    ]);
    await settle();
    const doc = storedDoc(browser);
    for (const t of [a, b]) {
      const s = t.profiles.useProfiles.getState();
      expect(s.profiles).toEqual(doc.profiles);
      expect(s.activeProfileId).toBe(t.profiles.profileOf(alex)?.id);
      expect(s.activeProfileId).not.toBeNull();
    }
  });

  // Two people turned to kids mode in two tabs at once: the second, made again over the
  // first's document, is refused (a device always keeps a grown-up).
  it('kids mode turned on in two tabs at once still leaves a grown-up', async () => {
    // Two people: alex (B's) and jo (added in A).
    const browser = fakeBrowser();
    const b = openTab(browser);
    await b.useSession.getState().hydrate();
    const alex = await signIn(b, 1, 'alex', 'ta');
    await b.profiles.useProfiles.getState().hydrate();
    const a = openTab(browser);
    await a.useSession.getState().hydrate();
    await a.profiles.useProfiles.getState().hydrate();
    const jo = await signIn(a, 3, 'jo', 'tj', 'other');
    const joPerson = a.profiles.placeConnection(jo, { newProfile: true, keepActive: true })!;
    await settle();
    const alexPerson = b.profiles.profileOf(alex)!.id;
    expect(b.profiles.useProfiles.getState().profiles.map((p) => p.id)).toEqual([
      alexPerson,
      joPerson,
    ]);
    const release = browser.hold();
    a.profiles.setProfileKids(joPerson, { bedtime: '18:00' });
    await until(
      () => !!storedDoc(browser).profiles.find((p) => p.id === joPerson)?.kids,
      "A's kids mode written",
    );
    // B, told of none of it yet, asks of its own copy (where jo is still a grown-up).
    b.profiles.setProfileKids(alexPerson, { bedtime: '18:00' });
    await settle();
    release();
    await settle();
    const doc = storedDoc(browser);
    expect(doc.profiles.find((p) => p.id === joPerson)?.kids).toBeDefined();
    expect(doc.profiles.find((p) => p.id === alexPerson)?.kids).toBeUndefined();
  });

  it('a token stored again in another tab is the one this tab sends, its reconnect flag cleared', async () => {
    const { a, b, alex } = await twoTabs();
    a.useSession.getState().markNeedsReconnect(alex, 'auth');
    await signIn(b, 1, 'alex', 'ta2');
    await settle();
    const conn = a.useSession.getState().connections.find((c) => c.id === alex);
    expect(conn?.token).toBe('ta2');
    expect(conn?.needsReconnect).toBeUndefined();
  });

  it("keeps its own default and reconnect flags through another tab's write", async () => {
    const { a, b, alex, sam } = await twoTabs();
    a.useSession.getState().markNeedsReconnect(sam, 'auth');
    await b.useSession.getState().setDefaultConnection(sam);
    await b.useSession.getState().setConnectionUser(alex, mkUser(1, 'alexander'));
    await settle();
    const s = a.useSession.getState();
    expect(s.connections.find((c) => c.id === alex)?.user.username).toBe('alexander');
    expect(s.defaultConnectionId).toBe(alex);
    expect(s.connections.find((c) => c.id === sam)?.needsReconnect).toBe('auth');
  });

  // The tab that changed the list writes the people that go with it; a tab following it
  // never works them out from its own copy.
  it('never writes people of its own for a list it followed', async () => {
    const browser = fakeBrowser();
    const b = openTab(browser);
    await b.useSession.getState().hydrate();
    await signIn(b, 1, 'alex', 'ta');
    await b.profiles.useProfiles.getState().hydrate();
    await settle();
    const before = browser.data.get(PROFILES_KEY);
    const a = openTab(browser); // its people never read
    await a.useSession.getState().hydrate();
    const jo = await signIn(a, 3, 'jo', 'tj', 'other');
    await settle();
    expect(b.useSession.getState().connections.map((c) => c.id)).toContain(jo);
    expect(browser.data.get(PROFILES_KEY)).toBe(before);
  });
});

// Two tabs write at the same moment: each reads what is stored before the other's write is
// heard. The lock the tabs share for each document has the second read the first's write.
describe('two tabs writing at once (web, Web Locks)', () => {
  const nav = globalThis.navigator as { locks?: unknown };
  beforeEach(() => {
    Object.defineProperty(nav, 'locks', { configurable: true, value: fakeWebLocks() });
  });
  afterEach(() => {
    delete nav.locks;
  });

  it('keeps both sign-ins', async () => {
    const { a, b, browser } = await twoTabs();
    const release = browser.hold();
    const [jo, kim] = await Promise.all([
      signIn(a, 3, 'jo', 'tj', 'other'),
      signIn(b, 4, 'kim', 'tk', 'third'),
    ]);
    release();
    await settle();
    expect(storedIds(browser)).toEqual(expect.arrayContaining([jo, kim]));
    for (const t of [a, b]) {
      expect(t.useSession.getState().connections.map((c) => c.id)).toEqual(
        expect.arrayContaining([jo, kim]),
      );
    }
  });

  it("keeps both tabs' changes to the people", async () => {
    const { a, b, alex, sam, browser } = await twoTabs();
    for (const t of [a, b]) await t.profiles.useProfiles.getState().hydrate();
    await settle();
    const alexPerson = a.profiles.profileOf(alex)!.id;
    const samPerson = a.profiles.profileOf(sam)!.id;
    const release = browser.hold();
    a.profiles.renameProfile(alexPerson, 'Alexander');
    b.profiles.renameProfile(samPerson, 'Samantha');
    await settle();
    release();
    await settle();
    const doc = storedDoc(browser);
    expect(doc.profiles.find((p) => p.id === alexPerson)?.name).toBe('Alexander');
    expect(doc.profiles.find((p) => p.id === samPerson)?.name).toBe('Samantha');
  });
});

describe('a connection about to go (web)', () => {
  it('waits for a tab with work for it (its stop and saves) before going on', async () => {
    const { a, b, alex } = await twoTabs();
    const order: string[] = [];
    b.onConnectionGoingInOtherTab((id) =>
      id === alex
        ? (async () => {
            order.push('B stops');
            await sleep(40);
            order.push('B sent');
          })()
        : null,
    );
    await a.tellOtherTabsGoing(alex, { answerMs: 20, flushMs: 2000 });
    order.push('A revokes');
    expect(order).toEqual(['B stops', 'B sent', 'A revokes']);
  });

  it('waits only for the answers when no tab has work for it', async () => {
    const { a, b, sam } = await twoTabs();
    const step = jest.fn((_id: string) => null);
    b.onConnectionGoingInOtherTab(step);
    const start = Date.now();
    await a.tellOtherTabsGoing(sam, { answerMs: 20, flushMs: 5000 });
    expect(Date.now() - start).toBeLessThan(1000);
    expect(step).toHaveBeenCalledWith(sam);
  });

  it('goes on after the bound when a tab never finishes', async () => {
    const { a, b, alex } = await twoTabs();
    const step = jest.fn((_id: string) => new Promise<void>(() => {}));
    b.onConnectionGoingInOtherTab(step);
    const start = Date.now();
    await a.tellOtherTabsGoing(alex, { answerMs: 10, flushMs: 80 });
    // It waited for B's answer, up to the bound, and no longer.
    expect(step).toHaveBeenCalledWith(alex);
    expect(Date.now() - start).toBeGreaterThanOrEqual(70);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('is nothing off the web', async () => {
    const { a, b, alex } = await twoTabs();
    const step = jest.fn(() => null);
    b.onConnectionGoingInOtherTab(step);
    a.setTabsForTests({ channel: null, env: null });
    await a.tellOtherTabsGoing(alex, { answerMs: 5000, flushMs: 5000 });
    await settle();
    expect(step).not.toHaveBeenCalled();
  });
});
