import { create } from 'zustand';

import type { User } from '@/api/types';
import { deleteSecure, getSecure, setSecure } from '@/lib/secure-store';
import { getItem, removeItem, setItem } from '@/lib/storage';

const SERVER_KEY = 'audiosilo.serverUrl';
const TOKEN_KEY = 'audiosilo.token';
const USER_KEY = 'audiosilo.user';

export type SessionStatus = 'loading' | 'unauthenticated' | 'authenticated';

type SessionState = {
  status: SessionStatus;
  serverUrl: string | null;
  token: string | null;
  user: User | null;

  /** Restore persisted session on app start. */
  hydrate: () => Promise<void>;
  /** Persist a full authenticated session (after login/exchange). */
  setSession: (s: { serverUrl: string; token: string; user: User }) => Promise<void>;
  /** Remember the server URL before authenticating. */
  setServerUrl: (url: string) => Promise<void>;
  setUser: (user: User) => Promise<void>;
  /** Clear the token/user but keep the server URL for re-login. */
  logout: () => Promise<void>;
};

export const useSession = create<SessionState>()((set) => ({
  status: 'loading',
  serverUrl: null,
  token: null,
  user: null,

  hydrate: async () => {
    const [serverUrl, token, user] = await Promise.all([
      getItem<string>(SERVER_KEY),
      getSecure(TOKEN_KEY),
      getItem<User>(USER_KEY),
    ]);
    set({
      serverUrl: serverUrl ?? null,
      token: token ?? null,
      user: user ?? null,
      status: token ? 'authenticated' : 'unauthenticated',
    });
  },

  setSession: async ({ serverUrl, token, user }) => {
    await Promise.all([
      setItem(SERVER_KEY, serverUrl),
      setSecure(TOKEN_KEY, token),
      setItem(USER_KEY, user),
    ]);
    set({ serverUrl, token, user, status: 'authenticated' });
  },

  setServerUrl: async (url) => {
    await setItem(SERVER_KEY, url);
    set({ serverUrl: url });
  },

  setUser: async (user) => {
    await setItem(USER_KEY, user);
    set({ user });
  },

  logout: async () => {
    await Promise.all([deleteSecure(TOKEN_KEY), removeItem(USER_KEY)]);
    set({ token: null, user: null, status: 'unauthenticated' });
  },
}));
