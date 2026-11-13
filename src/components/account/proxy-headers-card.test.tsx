import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';

import type { User } from '@/api/types';
import { useSession } from '@/stores/session';
import { mountWithPortal } from '@/testing/render-overlay';

import { ProxyHeadersCard } from './proxy-headers-card';

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
const stored = () => SecureStore.getItemAsync('audiosilo.proxy-headers.srv.1');

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
  await AsyncStorage.clear();
  await SecureStore.deleteItemAsync('audiosilo.proxy-headers.srv.1');
  useSession.setState({ connections: [], defaultConnectionId: null, pendingProxyHeaders: null });
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
    await waitFor(() =>
      expect(useSession.getState().connections[0].proxyHeaders).toEqual({
        origin: AWAY,
        headers: [{ name: 'X-Auth', value: 'proxy-secret' }],
      }),
    );
    expect(JSON.parse((await stored())!).headers[0].value).toBe('proxy-secret');
    expect(screen.queryByText('proxy-secret')).toBeNull();
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
    expect(useSession.getState().connections[0].proxyHeaders).toEqual(SET);

    await fireEvent.changeText(names[0], 'X-Client');
    await fireEvent.press(screen.getByTestId('proxy-headers-save'));
    await waitFor(() =>
      expect(useSession.getState().connections[0].proxyHeaders?.headers).toEqual([
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
    await waitFor(() => expect(useSession.getState().connections[0].proxyHeaders).toBeUndefined());
    expect(await stored()).toBeNull();
  });
});
