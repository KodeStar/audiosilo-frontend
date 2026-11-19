import AsyncStorage from '@react-native-async-storage/async-storage';

import type { User } from '@/api/types';
import { useSession } from '@/stores/session';

import { ApiError } from './client';
import { resolveClient } from './connection-clients';
// The provider's removal cleanup ends a removed connection's episode.
import './provider';
import { noteProxyAnswer, resetProxyRefusalsForTests, useProxyRefusals } from './proxy-refusal';

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

it('a connection signed out takes its episode with it', async () => {
  noteProxyAnswer('srv-1.1', true);
  await useSession.getState().removeConnection('srv-1.1');
  expect(refused()).toEqual({});
});
