import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

import type { User } from '@/api/types';
import { useSession } from '@/stores/session';

const user: User = { id: 1, username: 'bob', role: 'user', disabled: false };

// Exercises the real session store over the in-memory storage mocks (jest.setup).
describe('session store', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    await SecureStore.deleteItemAsync('audiosilo.token');
    useSession.setState({ status: 'loading', serverUrl: null, token: null, user: null });
  });

  it('hydrates to unauthenticated when nothing is stored', async () => {
    await useSession.getState().hydrate();
    expect(useSession.getState().status).toBe('unauthenticated');
  });

  it('persists a session and restores it on a fresh hydrate', async () => {
    await useSession.getState().setSession({ serverUrl: 'https://h', token: 'tok', user });
    expect(useSession.getState().status).toBe('authenticated');

    // Wipe in-memory state, then prove it comes back from storage.
    useSession.setState({ status: 'loading', serverUrl: null, token: null, user: null });
    await useSession.getState().hydrate();

    const s = useSession.getState();
    expect(s.status).toBe('authenticated');
    expect(s.token).toBe('tok');
    expect(s.serverUrl).toBe('https://h');
    expect(s.user).toEqual(user);
  });

  it('logout clears the token and user but keeps the server url', async () => {
    await useSession.getState().setSession({ serverUrl: 'https://h', token: 'tok', user });
    await useSession.getState().logout();

    const s = useSession.getState();
    expect(s.status).toBe('unauthenticated');
    expect(s.token).toBeNull();
    expect(s.user).toBeNull();
    expect(s.serverUrl).toBe('https://h');
  });
});
