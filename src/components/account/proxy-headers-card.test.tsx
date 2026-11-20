import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';

import { noteProxyAnswer, resetProxyRefusalsForTests } from '@/api/proxy-refusal';
import type { User } from '@/api/types';
import { forgetProxySets, readProxySets } from '@/lib/proxy-headers-store';
import { useSession } from '@/stores/session';
import { mountWithPortal } from '@/testing/render-overlay';

import { ProxyHeadersCard } from './proxy-headers-card';

const mockRouterPush = jest.fn();
jest.mock('expo-router', () => ({ router: { push: (to: unknown) => mockRouterPush(to) } }));

const user: User = {
  id: 1,
  username: 'chris',
  role: 'user',
  disabled: false,
  has_password: true,
  has_recovery: false,
};
const AWAY = 'https://books.example.com';
const HOME = 'http://192.168.1.20:8080';
const SET = {
  origin: AWAY,
  headers: [
    { name: 'CF-Access-Client-Id', value: 'id.access' },
    { name: 'CF-Access-Client-Secret', value: 'proxy-secret' },
  ],
};
const kept = () => useSession.getState().proxySets;

async function signIn(proxyHeaders?: typeof SET) {
  await useSession.getState().setSession({
    serverUrl: AWAY,
    serverId: 'srv',
    token: 't',
    user,
    addresses: { home: HOME, away: AWAY },
    ...(proxyHeaders ? { proxyHeaders } : {}),
  });
}

beforeEach(async () => {
  resetProxyRefusalsForTests();
  mockRouterPush.mockClear();
  await forgetProxySets();
  await AsyncStorage.clear();
  useSession.setState({
    connections: [],
    defaultConnectionId: null,
    pendingProxyHeaders: null,
    proxySets: {},
  });
});

describe('ProxyHeadersCard (fe#167)', () => {
  it('lists the header names with their values hidden, and where they go', async () => {
    await signIn(SET);
    await mountWithPortal(<ProxyHeadersCard connectionId="srv.1" />);
    expect(screen.getByText('CF-Access-Client-Id')).toBeTruthy();
    expect(screen.getByText('CF-Access-Client-Secret')).toBeTruthy();
    expect(screen.getByLabelText('CF-Access-Client-Secret, value hidden')).toBeTruthy();
    expect(screen.getByText(`Sent with requests to ${AWAY}.`)).toBeTruthy();
    expect(screen.queryByText(/proxy-secret|id\.access/)).toBeNull();
  });

  it('offers no headers for a server this device reaches over plain http only', async () => {
    await useSession.getState().setSession({
      serverUrl: HOME,
      serverId: 'srv',
      token: 't',
      user,
      addresses: { home: HOME },
    });
    await mountWithPortal(<ProxyHeadersCard connectionId="srv.1" />);
    expect(screen.getByTestId('proxy-headers-https-only')).toBeTruthy();
    expect(screen.queryByTestId('proxy-headers-start')).toBeNull();
  });

  it('adds headers for the chosen address, kept in secure-store', async () => {
    await signIn();
    await mountWithPortal(<ProxyHeadersCard connectionId="srv.1" />);
    await fireEvent.press(screen.getByTestId('proxy-headers-start'));
    // The away address: the plain-http home one is never offered, so there is no choice.
    expect(screen.queryByText('192.168.1.20:8080')).toBeNull();
    expect(screen.queryByText('Send to')).toBeNull();
    await fireEvent.changeText(screen.getByTestId('proxy-headers-editor-name'), 'X-Auth');
    await fireEvent.changeText(screen.getByTestId('proxy-headers-editor-value'), 'proxy-secret');
    await fireEvent.press(screen.getByTestId('proxy-headers-save'));
    const set = { origin: AWAY, headers: [{ name: 'X-Auth', value: 'proxy-secret' }] };
    await waitFor(() => expect(kept()[AWAY]).toEqual(set));
    expect(await readProxySets()).toEqual({ [AWAY]: set });
    expect(screen.queryByText('proxy-secret')).toBeNull();
    // The address's set: says so.
    expect(screen.getByTestId('proxy-headers-shared')).toBeTruthy();
  });

  // fe#295: one set per address on the device, shown and edited from any sign-in there.
  it("shows another person's sign-in at the same address the same set, and the edit is theirs too", async () => {
    await signIn(SET);
    await useSession.getState().setSession({
      serverUrl: AWAY,
      serverId: 'srv',
      token: 't2',
      user: { ...user, id: 2, username: 'maya' },
    });
    await mountWithPortal(<ProxyHeadersCard connectionId="srv.2" />);
    expect(screen.getByLabelText('CF-Access-Client-Secret, value hidden')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('proxy-headers-remove'));
    await fireEvent.press(screen.getAllByText('Remove headers').at(-1)!);
    await waitFor(() => expect(kept()).toEqual({}));
    expect(await readProxySets()).toEqual({});
  });

  it('moves the set when it is sent to another address', async () => {
    const httpsHome = 'https://nas.home.example:8443';
    await useSession.getState().setSession({
      serverUrl: AWAY,
      serverId: 'srv',
      token: 't',
      user,
      addresses: { home: httpsHome, away: AWAY },
      proxyHeaders: SET,
    });
    await mountWithPortal(<ProxyHeadersCard connectionId="srv.1" />);
    await fireEvent.press(screen.getByTestId('proxy-headers-edit'));
    await fireEvent.press(screen.getByText('nas.home.example:8443'));
    await fireEvent.press(screen.getByTestId('proxy-headers-save'));
    await waitFor(() => expect(Object.keys(kept())).toEqual([httpsHome]));
    expect(kept()[httpsHome]?.headers).toEqual(SET.headers);
    expect(Object.keys(await readProxySets())).toEqual([httpsHome]);
  });

  it('offers a choice between https addresses, the home one too when it is https', async () => {
    const httpsHome = 'https://nas.home.example:8443';
    await useSession.getState().setSession({
      serverUrl: AWAY,
      serverId: 'srv',
      token: 't',
      user,
      addresses: { home: httpsHome, away: AWAY },
    });
    await mountWithPortal(<ProxyHeadersCard connectionId="srv.1" />);
    await fireEvent.press(screen.getByTestId('proxy-headers-start'));
    expect(screen.getAllByText('Send to').length).toBeGreaterThan(0);
    expect(screen.getByText('books.example.com')).toBeTruthy();
    expect(screen.getByText('nas.home.example:8443')).toBeTruthy();
  });

  it('a change keeps a stored value left blank, and refuses a row with a problem', async () => {
    await signIn(SET);
    await mountWithPortal(<ProxyHeadersCard connectionId="srv.1" />);
    await fireEvent.press(screen.getByTestId('proxy-headers-edit'));
    const values = screen.getAllByTestId('proxy-headers-editor-value');
    expect(values.map((v) => v.props.value)).toEqual(['', '']);
    expect(values[0].props.placeholder).toBe('Kept as it is');

    const names = screen.getAllByTestId('proxy-headers-editor-name');
    await fireEvent.changeText(names[0], 'Authorization');
    await fireEvent.press(screen.getByTestId('proxy-headers-save'));
    expect(screen.getByText('The app sends Authorization itself.')).toBeTruthy();
    expect(kept()[AWAY]).toEqual(SET);

    await fireEvent.changeText(names[0], 'X-Client');
    await fireEvent.press(screen.getByTestId('proxy-headers-save'));
    await waitFor(() =>
      expect(kept()[AWAY]?.headers).toEqual([
        { name: 'X-Client', value: 'id.access' },
        { name: 'CF-Access-Client-Secret', value: 'proxy-secret' },
      ]),
    );
  });

  it('removes them after asking', async () => {
    await signIn(SET);
    await mountWithPortal(<ProxyHeadersCard connectionId="srv.1" />);
    await fireEvent.press(screen.getByTestId('proxy-headers-remove'));
    expect(screen.getByText('Remove the proxy headers?')).toBeTruthy();
    await fireEvent.press(screen.getAllByText('Remove headers').at(-1)!);
    await waitFor(() => expect(kept()[AWAY]).toBeUndefined());
    expect(await SecureStore.getItemAsync('audiosilo.proxy-sets')).toBeNull();
  });
  // WS-401-MARK: a real revoke behind a proxy that drops the server's 401 mark reads as the
  // proxy's refusal; the card's way out is the app's normal sign-in for the connection.
  it('offers Sign in again while a proxy turns a full account away, through the reconnect flow', async () => {
    await signIn(SET);
    await mountWithPortal(<ProxyHeadersCard connectionId="srv.1" />);
    expect(screen.queryByTestId('proxy-headers-sign-in-again')).toBeNull();
    await act(async () => noteProxyAnswer('srv.1', 401));
    expect(
      screen.getByText(
        'If the proxy headers are right, your sign-in to books.example.com may have ended: sign in again.',
      ),
    ).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Sign in again to books.example.com'));
    await waitFor(() =>
      expect(mockRouterPush).toHaveBeenCalledWith({
        pathname: '/connect/sign-in',
        params: { serverName: 'books.example.com' },
      }),
    );
  });

  // A proxy's own 403 is no revoke in disguise: no sign-in gets past it.
  it("offers no Sign in again for a proxy's 403", async () => {
    await signIn(SET);
    noteProxyAnswer('srv.1', 403);
    await mountWithPortal(<ProxyHeadersCard connectionId="srv.1" />);
    expect(screen.queryByTestId('proxy-headers-sign-in-again')).toBeNull();
    await act(async () => noteProxyAnswer('srv.1', 401));
    expect(screen.getByTestId('proxy-headers-sign-in-again')).toBeTruthy();
  });

  it('offers no Sign in again to a kid, who signs in some other way', async () => {
    await useSession.getState().setSession({
      serverUrl: AWAY,
      serverId: 'srv',
      token: 't',
      user: { ...user, id: 12, username: 'evie', member_kind: 'kid' },
      addresses: { home: HOME, away: AWAY },
    });
    noteProxyAnswer('srv.12', 401);
    await mountWithPortal(<ProxyHeadersCard connectionId="srv.12" />);
    expect(screen.queryByTestId('proxy-headers-sign-in-again')).toBeNull();
  });
});
