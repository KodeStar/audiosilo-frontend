import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

/**
 * Token storage. expo-secure-store (Keychain/Keystore) on native; localStorage
 * on web, where SecureStore is unavailable. Used only for the session token.
 *
 * iOS keeps tokens readable with the phone LOCKED (after its first unlock since boot): CarPlay
 * starts books with the phone in a pocket, and the default `WHEN_UNLOCKED` item can't be read
 * then. Tokens therefore live in their own keychain service, written `AFTER_FIRST_UNLOCK`.
 *
 * Why a separate service and not a re-save in place: expo-secure-store's `setItemAsync` does a
 * `SecItemAdd` and, on `errSecDuplicateItem` (an item with the same service + account already
 * exists; accessibility is not part of that identity), a `SecItemUpdate` of the DATA only, so
 * re-saving an existing token never changes its accessibility. The only way to change it through
 * the module is a new item, which must not cost the old one: see `migrate`.
 * (A read doesn't need the accessibility: the module's query is class + service + account.)
 */
const IOS_TOKENS: SecureStore.SecureStoreOptions = {
  keychainService: 'audiosilo.tokens.afu',
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
};

export async function getSecure(key: string): Promise<string | null> {
  if (Platform.OS === 'web') {
    try {
      return globalThis.localStorage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }
  if (Platform.OS !== 'ios') return SecureStore.getItemAsync(key);
  const current = await SecureStore.getItemAsync(key, IOS_TOKENS);
  if (current != null) return current;
  // Not moved yet: the item an earlier build wrote (the module's default service). Every token
  // is read at launch (session hydrate), so this is the one-time launch migration.
  const legacy = await SecureStore.getItemAsync(key);
  if (legacy != null) await migrate(key, legacy);
  return legacy;
}

/**
 * Copy a token from the default-service `WHEN_UNLOCKED` item to the `AFTER_FIRST_UNLOCK` one:
 * write, read back, and only once the copy reads back equal delete the old item. Never deletes
 * first. Any failure leaves the old item as it was (and removes a copy that didn't verify), so
 * the next launch tries again; until then reads keep falling back to the old item.
 */
async function migrate(key: string, value: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(key, value, IOS_TOKENS);
    if ((await SecureStore.getItemAsync(key, IOS_TOKENS)) !== value) {
      throw new Error('token copy did not verify');
    }
  } catch (e) {
    console.warn('[secure-store] keychain move failed, retrying next launch', e);
    await SecureStore.deleteItemAsync(key, IOS_TOKENS).catch(() => undefined);
    return;
  }
  // Verified: drop the old copy. Best-effort; a leftover is shadowed by the new item and goes
  // with the next `deleteSecure`.
  await SecureStore.deleteItemAsync(key).catch(() => undefined);
}

export async function setSecure(key: string, value: string): Promise<void> {
  if (Platform.OS === 'web') {
    try {
      globalThis.localStorage?.setItem(key, value);
    } catch {
      // ignore
    }
    return;
  }
  if (Platform.OS === 'ios') {
    await SecureStore.setItemAsync(key, value, IOS_TOKENS);
    return;
  }
  await SecureStore.setItemAsync(key, value);
}

export async function deleteSecure(key: string): Promise<void> {
  if (Platform.OS === 'web') {
    try {
      globalThis.localStorage?.removeItem(key);
    } catch {
      // ignore
    }
    return;
  }
  if (Platform.OS === 'ios') {
    // Both homes: the token may not have moved yet (or its old copy outlived the move).
    await Promise.all([
      SecureStore.deleteItemAsync(key, IOS_TOKENS),
      SecureStore.deleteItemAsync(key),
    ]);
    return;
  }
  await SecureStore.deleteItemAsync(key);
}
