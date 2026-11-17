import { getItem } from '@/lib/storage';

import { getSignInKey, resetSignInKeyForTests } from './sign-in-key';

jest.mock('@/lib/storage', () => {
  const store = new Map<string, unknown>();
  return {
    getItem: jest.fn(async (k: string) => store.get(k) ?? null),
    setItem: jest.fn(async (k: string, v: unknown) => void store.set(k, v)),
  };
});

beforeEach(() => resetSignInKeyForTests());

it('makes one random key per install and keeps it', async () => {
  const key = await getSignInKey();
  expect(key).toMatch(/^[0-9a-f]{32}$/);
  resetSignInKeyForTests();
  expect(await getSignInKey()).toBe(key);
  expect(await getItem('audiosilo.signInKey')).toBe(key);
});
