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

// Another tab adds a key after this one read the list: this one's next key keeps it.
it('keeps a key another tab stored after this one read the list', async () => {
  const home = await getSignInKey(HOME);
  const { setItem } = jest.requireMock('@/lib/storage') as {
    setItem: (k: string, v: unknown) => Promise<void>;
  };
  await setItem('audiosilo.signInKeys', {
    [HOME]: home,
    'https://tab.example.com': 'b'.repeat(32),
  });
  await getSignInKey('https://other.example.com');
  expect(await getSignInKey('https://tab.example.com')).toBe('b'.repeat(32));
  expect(await getItem('audiosilo.signInKeys')).toMatchObject({
    [HOME]: home,
    'https://tab.example.com': 'b'.repeat(32),
  });
});

it('gives two sign-ins at one new address the same key', async () => {
  const NEW = 'https://new.example.com';
  const [a, b] = await Promise.all([getSignInKey(NEW), getSignInKey(NEW)]);
  expect(a).toBe(b);
  expect(await getItem('audiosilo.signInKeys')).toMatchObject({ [NEW]: a });
});
