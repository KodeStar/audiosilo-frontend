import { getItem } from '@/lib/storage';

import { getSignInKey, resetSignInKeyForTests } from './sign-in-key';

jest.mock('@/lib/storage', () => {
  const store = new Map<string, unknown>();
  return {
    getItem: jest.fn(async (k: string) => store.get(k) ?? null),
    setItem: jest.fn(async (k: string, v: unknown) => void store.set(k, structuredClone(v))),
  };
});

beforeEach(() => resetSignInKeyForTests());

const HOME = 'https://books.example.com';

it('makes one random key for a server and keeps it', async () => {
  const key = await getSignInKey(HOME);
  expect(key).toMatch(/^[0-9a-f]{32}$/);
  expect(await getSignInKey(`${HOME}/`)).toBe(key);
  resetSignInKeyForTests();
  expect(await getSignInKey(HOME)).toBe(key);
  expect(await getItem('audiosilo.signInKeys')).toEqual({ [HOME]: key });
});

// The server keeps the key as a secret: one server must never be sent another's.
it('never sends one server the key another knows this install by', async () => {
  const [home, other] = await Promise.all([
    getSignInKey(HOME),
    getSignInKey('https://other.example.com'),
  ]);
  expect(other).toMatch(/^[0-9a-f]{32}$/);
  expect(other).not.toBe(home);
  resetSignInKeyForTests();
  expect(await getSignInKey(HOME)).toBe(home);
  expect(await getSignInKey('https://other.example.com')).toBe(other);
});
