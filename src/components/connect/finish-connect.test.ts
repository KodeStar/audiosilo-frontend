import AsyncStorage from '@react-native-async-storage/async-storage';

import type { AuthSession, User } from '@/api/types';
import { useSession } from '@/stores/session';

import { finishConnect } from './finish-connect';

const mockReplace = jest.fn();
const mockDismissTo = jest.fn();
jest.mock('expo-router', () => ({
  router: {
    replace: (h: unknown) => mockReplace(h),
    dismissTo: (h: unknown) => mockDismissTo(h),
  },
}));

const user: User = {
  id: 1,
  username: 'chris',
  role: 'user',
  disabled: false,
  has_password: true,
  has_recovery: false,
};
const session = (id: string, extra: Partial<AuthSession> = {}): AuthSession => ({
  token: `tok-${id}`,
  server_id: id,
  user,
  ...extra,
});

const HOME = 'http://192.168.1.20:8080';
const AWAY = 'https://books.example.com';

beforeEach(async () => {
  await AsyncStorage.clear();
  mockReplace.mockClear();
  mockDismissTo.mockClear();
  useSession.setState({
    status: 'unauthenticated',
    connections: [],
    defaultConnectionId: null,
    pendingServerUrl: null,
    user: null,
  });
});

const conn = (id: string) => useSession.getState().connections.find((c) => c.id === id);

it('ends the first sign-in on "Your library is ready." for the new connection', async () => {
  await finishConnect({
    serverUrl: AWAY,
    session: session('srv-1'),
    addresses: { home: HOME, away: AWAY },
    name: 'Hearthside',
  });
  expect(mockReplace).toHaveBeenCalledWith({
    pathname: '/connect/ready',
    params: { connection: 'srv-1' },
  });
  expect(mockDismissTo).not.toHaveBeenCalled();
  expect(conn('srv-1')).toMatchObject({
    serverUrl: AWAY,
    name: 'Hearthside',
    addresses: { home: HOME, away: AWAY },
  });
});

it('goes straight back to the app for an added server', async () => {
  await finishConnect({ serverUrl: AWAY, session: session('srv-1') });
  mockReplace.mockClear();
  await finishConnect({ serverUrl: 'https://other.example.com', session: session('srv-2') });
  expect(mockReplace).not.toHaveBeenCalled();
  expect(mockDismissTo).toHaveBeenCalledWith('/');
});

it('names the connection after its host when the flow does not know the name', async () => {
  await finishConnect({ serverUrl: AWAY, session: session('srv-1') });
  expect(conn('srv-1')?.name).toBe('books.example.com');
});

it('a reconnect through the away address keeps the address the server was paired with', async () => {
  await finishConnect({
    serverUrl: HOME,
    session: session('srv-1'),
    addresses: { home: HOME, away: AWAY },
  });
  await finishConnect({
    serverUrl: AWAY,
    session: session('srv-1', { token: 'fresh' }),
    addresses: { away: AWAY },
    reconnectId: 'srv-1',
  });
  expect(useSession.getState().connections).toHaveLength(1);
  expect(conn('srv-1')).toMatchObject({
    serverUrl: HOME,
    token: 'fresh',
    addresses: { home: HOME, away: AWAY },
  });
});

it('a reset server reached through its away address retires the dead identity', async () => {
  await finishConnect({
    serverUrl: HOME,
    session: session('old'),
    addresses: { home: HOME, away: AWAY },
  });
  useSession.getState().markNeedsReconnect('old', 'server-reset');
  await finishConnect({
    serverUrl: AWAY,
    session: session('new'),
    addresses: { away: AWAY },
    reconnectId: 'old',
  });
  const ids = useSession.getState().connections.map((c) => c.id);
  expect(ids).toEqual(['new']);
  expect(conn('new')).toMatchObject({
    serverUrl: HOME,
    addresses: { home: HOME, away: AWAY },
  });
});
