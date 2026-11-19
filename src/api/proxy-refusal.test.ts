import AsyncStorage from '@react-native-async-storage/async-storage';

import type { User } from '@/api/types';
import { useSession } from '@/stores/session';

import { ApiError } from './client';
import { resolveClient } from './connection-clients';
// The provider's removal cleanup ends a removed connection's episode.
import './provider';
import {
  moveProxyRefusal,
  noteProxyAnswer,
  onProxyRefusalsOver,
  resetProxyRefusalsForTests,
  useProxyRefusals,
} from './proxy-refusal';

const user: User = {
  id: 1,
  username: 'chris',
  role: 'user',
  disabled: false,
  has_password: true,
  has_recovery: false,
};
const AWAY = 'https://books.example.com';

/** A fetch that answers every request with `status` and `text` (a proxy's page: no JSON). */
function answerAll(status: number, text: string) {
  globalThis.fetch = jest.fn(() =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      statusText: '',
      headers: { get: () => null },
      text: () => Promise.resolve(text),
    } as unknown as Response),
  ) as unknown as typeof globalThis.fetch;
}

const refused = () => useProxyRefusals.getState().refused;

beforeEach(async () => {
  resetProxyRefusalsForTests();
  await AsyncStorage.clear();
  useSession.setState({ status: 'unauthenticated', connections: [], defaultConnectionId: null });
  await useSession.getState().setSession({
    serverUrl: AWAY,
    serverId: 'srv-1',
    token: 'tok',
    user,
    name: 'Hearthside',
  });
});

it('starts an episode at the first refusal and ends it at the next success, once each', () => {
  const states: unknown[] = [];
  const stop = useProxyRefusals.subscribe((s) => states.push(s.refused));
  try {
    noteProxyAnswer('srv-1.1', true);
    noteProxyAnswer('srv-1.1', true);
    expect(refused()).toEqual({ 'srv-1.1': true });
    noteProxyAnswer('srv-1.1', false);
    noteProxyAnswer('srv-1.1', false);
    expect(refused()).toEqual({});
    // One change in, one out: never once per request.
    expect(states).toHaveLength(2);
  } finally {
    stop();
  }
});

it("a signed-in connection's client starts and ends the episode itself, and it is never a sign-out", async () => {
  const client = resolveClient('srv-1.1')!;
  answerAll(403, '<html>Forbidden</html>');
  await expect(client.me()).rejects.toBeInstanceOf(ApiError);
  expect(refused()).toEqual({ 'srv-1.1': true });
  expect(useSession.getState().connections[0].needsReconnect).toBeUndefined();
  answerAll(200, JSON.stringify(user));
  await client.me();
  expect(refused()).toEqual({});
});

it("the server's own 403 starts no episode", async () => {
  answerAll(403, JSON.stringify({ error: 'admin only' }));
  await expect(resolveClient('srv-1.1')!.me()).rejects.toBeInstanceOf(ApiError);
  expect(refused()).toEqual({});
});

it('a connection signed out takes its episode with it, telling no queue to send', async () => {
  const over = jest.fn();
  const stop = onProxyRefusalsOver(over);
  try {
    noteProxyAnswer('srv-1.1', true);
    await useSession.getState().removeConnection('srv-1.1');
    expect(refused()).toEqual({});
    expect(over).not.toHaveBeenCalled();
  } finally {
    stop();
  }
});

// The stored queues send what the refusals held at once (`onProxyRefusalsOver`).
it("tells the queues once an episode ends, that connection's only and once", () => {
  const over = jest.fn();
  const stop = onProxyRefusalsOver(over);
  try {
    noteProxyAnswer('srv-1.1', true);
    expect(over).not.toHaveBeenCalled();
    noteProxyAnswer('srv-1.1', false);
    noteProxyAnswer('srv-1.1', false);
    expect(over.mock.calls).toEqual([['srv-1.1']]);
  } finally {
    stop();
  }
});

it('tells no queue of an episode ended on a connection that needs signing in again', () => {
  const over = jest.fn();
  const stop = onProxyRefusalsOver(over);
  try {
    noteProxyAnswer('srv-1.1', true);
    useSession.getState().markNeedsReconnect('srv-1.1', 'auth');
    noteProxyAnswer('srv-1.1', false);
    expect(refused()).toEqual({});
    expect(over).not.toHaveBeenCalled();
  } finally {
    stop();
  }
});

// Another tab's identity migration renamed the connection: its client's answers are noted
// under the new id, so the episode goes there, where the next server answer ends it.
describe('a rename (moveProxyRefusal)', () => {
  const renameTo = (to: string) =>
    useSession.setState((s) => ({
      connections: s.connections.map((c) => (c.id === 'srv-1.1' ? { ...c, id: to } : c)),
    }));

  it('carries an open episode to the new id, which then ends it', () => {
    const over = jest.fn();
    const stop = onProxyRefusalsOver(over);
    try {
      noteProxyAnswer('srv-1.1', true);
      renameTo('srv-1.7');
      moveProxyRefusal('srv-1.1', 'srv-1.7');
      expect(refused()).toEqual({ 'srv-1.7': true });
      // Moved, not ended: nothing to send yet.
      expect(over).not.toHaveBeenCalled();
      noteProxyAnswer('srv-1.7', false);
      expect(refused()).toEqual({});
      expect(over.mock.calls).toEqual([['srv-1.7']]);
    } finally {
      stop();
    }
  });

  it('ends the episode when the new id is not signed in', () => {
    noteProxyAnswer('srv-1.1', true);
    renameTo('srv-1.7');
    useSession.getState().markNeedsReconnect('srv-1.7', 'auth');
    moveProxyRefusal('srv-1.1', 'srv-1.7');
    expect(refused()).toEqual({});
  });

  it('moves nothing for a connection with no episode', () => {
    noteProxyAnswer('other', true);
    moveProxyRefusal('srv-1.1', 'srv-1.7');
    expect(refused()).toEqual({ other: true });
  });
});

// The headers fixed meanwhile (a grown-up's update): a request still out with the set before
// that answers late says nothing of the one the connection sends now.
it('a late refusal of a set since replaced starts no episode', async () => {
  const set = (value: string) => ({ origin: AWAY, headers: [{ name: 'X-Proxy', value }] });
  await useSession.getState().setProxySet(AWAY, set('stale'));
  try {
    const before = resolveClient('srv-1.1')!;
    await useSession.getState().setProxySet(AWAY, set('fresh'));
    answerAll(403, '<html>Forbidden</html>');
    await expect(before.me()).rejects.toBeInstanceOf(ApiError);
    expect(refused()).toEqual({});
    // The set it sends now, refused: that one says so.
    await expect(resolveClient('srv-1.1')!.me()).rejects.toBeInstanceOf(ApiError);
    expect(refused()).toEqual({ 'srv-1.1': true });
  } finally {
    await useSession.getState().setProxySet(AWAY, null);
  }
});
