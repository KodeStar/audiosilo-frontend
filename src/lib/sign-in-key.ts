import { getItem, setItem } from '@/lib/storage';

import { randomBytes, toHex } from './random';

const SIGN_IN_KEY = 'audiosilo.signInKey';
let cache: string | null = null;

/**
 * This install's own random key for a password sign-in (`device_id` on `POST /auth/login`),
 * so signing in again from it is not announced to the admin as a new device (fe#159). Never
 * progress sync's device id: that one goes with every save and comes back in progress
 * answers, while the server keeps this one as a secret (hashed), as the admin console's.
 */
export async function getSignInKey(): Promise<string> {
  if (cache) return cache;
  let key = await getItem<string>(SIGN_IN_KEY);
  if (!key) {
    key = toHex(randomBytes(16));
    await setItem(SIGN_IN_KEY, key);
  }
  cache = key;
  return key;
}

/** Forgets the key read this launch (tests only). */
export function resetSignInKeyForTests(): void {
  cache = null;
}
