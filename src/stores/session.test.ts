import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

import type { User } from '@/api/types';
import { useSession } from '@/stores/session';

const mkUser = (name: string): User => ({
  id: 1,
  username: name,
  role: 'user',
  disabled: false,
  has_password: false,
  has_recovery: false,
});

const reset = () =>
  useSession.setState({
    status: 'loading',
    connections: [],
    activeConnectionId: null,
    pendingServerUrl: null,
    user: null,
    activeServerUrl: null,
  });

// Exercises the real session store over the in-memory storage mocks (jest.setup).
describe('session store (multi-connection)', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    reset();
  });

  it('hydrates to unauthenticated when nothing is stored', async () => {
    await useSession.getState().hydrate();
    expect(useSession.getState().status).toBe('unauthenticated');
  });

  it('adds connections and restores them (with tokens) on a fresh hydrate', async () => {
    await useSession
      .getState()
      .setSession({ serverUrl: 'https://a', token: 'tokA', user: mkUser('a') });
    await useSession
      .getState()
      .setSession({ serverUrl: 'https://b', token: 'tokB', user: mkUser('b') });
    expect(useSession.getState().connections).toHaveLength(2);
    expect(useSession.getState().activeServerUrl).toBe('https://b'); // last added is active

    reset();
    await useSession.getState().hydrate();
    const s = useSession.getState();
    expect(s.status).toBe('authenticated');
    expect(s.connections.map((c) => c.serverUrl).sort()).toEqual(['https://a', 'https://b']);
    expect(s.connections.every((c) => c.token)).toBe(true);
  });

  it('re-adding the same server updates rather than duplicates', async () => {
    await useSession
      .getState()
      .setSession({ serverUrl: 'https://a', token: 't1', user: mkUser('a') });
    await useSession
      .getState()
      .setSession({ serverUrl: 'https://a', token: 't2', user: mkUser('a2') });
    const s = useSession.getState();
    expect(s.connections).toHaveLength(1);
    expect(s.connections[0].token).toBe('t2');
  });

  it('switches the active connection', async () => {
    const idA = await useSession
      .getState()
      .setSession({ serverUrl: 'https://a', token: 't', user: mkUser('a') });
    await useSession
      .getState()
      .setSession({ serverUrl: 'https://b', token: 't', user: mkUser('b') });
    await useSession.getState().setActiveConnection(idA);
    expect(useSession.getState().activeServerUrl).toBe('https://a');
    expect(useSession.getState().user?.username).toBe('a');
  });

  it('logout removes the active connection, falling back to another', async () => {
    await useSession
      .getState()
      .setSession({ serverUrl: 'https://a', token: 't', user: mkUser('a') });
    await useSession
      .getState()
      .setSession({ serverUrl: 'https://b', token: 't', user: mkUser('b') });
    await useSession.getState().logout(); // removes b (active)
    const s = useSession.getState();
    expect(s.connections).toHaveLength(1);
    expect(s.activeServerUrl).toBe('https://a');
    expect(s.status).toBe('authenticated');
    await useSession.getState().logout(); // removes the last one
    expect(useSession.getState().status).toBe('unauthenticated');
  });

  it('migrates a legacy single session into one connection', async () => {
    await AsyncStorage.setItem('audiosilo.serverUrl', JSON.stringify('https://legacy'));
    await AsyncStorage.setItem('audiosilo.user', JSON.stringify(mkUser('old')));
    await SecureStore.setItemAsync('audiosilo.token', 'legacytok');
    reset();

    await useSession.getState().hydrate();
    const s = useSession.getState();
    expect(s.status).toBe('authenticated');
    expect(s.connections).toHaveLength(1);
    expect(s.connections[0].serverUrl).toBe('https://legacy');
    expect(s.connections[0].token).toBe('legacytok');
    // Legacy keys are cleaned up after migration.
    expect(await AsyncStorage.getItem('audiosilo.serverUrl')).toBeNull();
    expect(await SecureStore.getItemAsync('audiosilo.token')).toBeNull();
  });
});
