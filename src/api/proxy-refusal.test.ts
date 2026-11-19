import AsyncStorage from '@react-native-async-storage/async-storage';
import { renderHook } from '@testing-library/react-native';

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
  useProxyRefused,
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
    noteProxyAnswer('srv-1.1', 401);
    noteProxyAnswer('srv-1.1', 401);
    expect(refused()).toEqual({ 'srv-1.1': 401 });
    noteProxyAnswer('srv-1.1', false);
    noteProxyAnswer('srv-1.1', false);
    expect(refused()).toEqual({});
    // One change in, one out: never once per request.
    expect(states).toHaveLength(2);
  } finally {
    stop();
  }
});

// WS-401-MARK: only a 401 may be the server's refusal of the token behind a proxy that drops
// its mark (Sign in again is offered then); a 403 never is. Once a 401 came, the episode keeps it.
it("keeps the refusals' status, a 401 once any was", () => {
  noteProxyAnswer('srv-1.1', 403);
  expect(refused()).toEqual({ 'srv-1.1': 403 });
  noteProxyAnswer('srv-1.1', 401);
  expect(refused()).toEqual({ 'srv-1.1': 401 });
  noteProxyAnswer('srv-1.1', 403);
  expect(refused()).toEqual({ 'srv-1.1': 401 });
  noteProxyAnswer('srv-1.1', false);
  expect(refused()).toEqual({});
});

it("a signed-in connection's client starts and ends the episode itself, and it is never a sign-out", async () => {
  const client = resolveClient('srv-1.1')!;
  answerAll(403, '<html>Forbidden</html>');
  await expect(client.me()).rejects.toBeInstanceOf(ApiError);
  expect(refused()).toEqual({ 'srv-1.1': 403 });
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
    noteProxyAnswer('srv-1.1', 401);
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
    noteProxyAnswer('srv-1.1', 401);
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
    noteProxyAnswer('srv-1.1', 401);
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
      noteProxyAnswer('srv-1.1', 403);
      renameTo('srv-1.7');
      moveProxyRefusal('srv-1.1', 'srv-1.7');
      // Its status with it.
      expect(refused()).toEqual({ 'srv-1.7': 403 });
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
    noteProxyAnswer('srv-1.1', 401);
    renameTo('srv-1.7');
    useSession.getState().markNeedsReconnect('srv-1.7', 'auth');
    moveProxyRefusal('srv-1.1', 'srv-1.7');
    expect(refused()).toEqual({});
  });

  it('moves nothing for a connection with no episode', () => {
    noteProxyAnswer('other', 401);
    moveProxyRefusal('srv-1.1', 'srv-1.7');
    expect(refused()).toEqual({ other: 401 });
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
    expect(refused()).toEqual({ 'srv-1.1': 403 });
  } finally {
    await useSession.getState().setProxySet(AWAY, null);
  }
});

// Why a read failed (the Library's load errors): only the refusal itself, never a sign-in's own
// set gone stale (`useProxyNotice` counts that too, though it turns nothing away), and never
// for a connection that needs signing in again.
it('says a read was refused only while an episode lasts', async () => {
  const { result, rerender } = await renderHook(() => useProxyRefused('srv-1.1'));
  expect(result.current).toBe(false);
  noteProxyAnswer('srv-1.1', 403);
  await rerender({});
  expect(result.current).toBe(true);
  useSession.getState().markNeedsReconnect('srv-1.1', 'auth');
  await rerender({});
  expect(result.current).toBe(false);
  const none = await renderHook(() => useProxyRefused(undefined));
  expect(none.result.current).toBe(false);
});
