import { render, screen } from '@testing-library/react-native';

import type { Connection } from '@/stores/session';

import { SignInAgainState } from './sign-in-again';

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));

const connection = (needsReconnect: Connection['needsReconnect']): Connection =>
  ({ id: 'a', name: 'Hearthside', serverUrl: 'https://h', needsReconnect }) as Connection;

// fe#147: the state says why, as the reconnect banner does.
describe('SignInAgainState', () => {
  it('asks to sign in again when the sign-in ended', async () => {
    await render(<SignInAgainState connection={connection('auth')} />);
    expect(screen.getByText('Sign in again to Hearthside')).toBeTruthy();
    expect(screen.getByText(/Your sign-in to Hearthside ended/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeTruthy();
  });

  it('says the server was reset, and to pair again, when it was', async () => {
    await render(<SignInAgainState connection={connection('server-reset')} />);
    expect(screen.getByText('Hearthside was reset')).toBeTruthy();
    expect(screen.getByText(/Pair this device with Hearthside again/)).toBeTruthy();
    expect(screen.queryByText('Sign in again to Hearthside')).toBeNull();
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeTruthy();
  });

  it('words the slim row by the reason too', async () => {
    await render(<SignInAgainState compact connection={connection('server-reset')} />);
    expect(screen.getByText('Hearthside was reset')).toBeTruthy();
  });
});
