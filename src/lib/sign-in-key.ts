import { getItem, setItem } from '@/lib/storage';

import { randomBytes, toHex } from './random';

const SIGN_IN_KEYS = 'audiosilo.signInKeys';
/** The keys kept, by server address: read from storage once a launch. */
let kept: Promise<Record<string, string>> | null = null;

function readKeys(): Promise<Record<string, string>> {
  kept ??= getItem<unknown>(SIGN_IN_KEYS).then((stored) =>
    stored && typeof stored === 'object' && !Array.isArray(stored)
      ? { ...(stored as Record<string, string>) }
      : {},
  );
  return kept;
}

/**
 * This install's own random key for sign-in at `serverUrl` (`device_id` on login and
 * exchange): a password sign-in can recognize the device, and an invite can replay a lost
 * exchange. One per server address, as the admin console's is one per origin: the server
 * keeps it as a secret (hashed), so no server is ever sent the key another one knows this
 * install by. Never progress sync's device id either: that one goes with every save
 * and comes back in progress answers.
 */
export async function getSignInKey(serverUrl: string): Promise<string> {
  const keys = await readKeys();
  // As `sameUrl` reads an address: a trailing slash never makes a second one.
  const address = serverUrl.replace(/\/+$/, '');
  const known = keys[address];
  if (typeof known === 'string' && known) return known;
  const key = toHex(randomBytes(16));
  keys[address] = key;
  await setItem(SIGN_IN_KEYS, keys);
  return key;
}

/** Forgets the keys read this launch (tests only). */
export function resetSignInKeyForTests(): void {
  kept = null;
}
