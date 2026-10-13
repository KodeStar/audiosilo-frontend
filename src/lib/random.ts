import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

type ExpoCrypto = typeof import('expo-crypto');

let loaded: ExpoCrypto | null | undefined;

/**
 * expo-crypto, when this build has it: the web always (its web side is the browser's
 * `crypto`), native only when the binary carries the `ExpoCrypto` module. Required lazily
 * behind that check, like expo-widgets in `widget-sync.ios.ts`: importing it on a binary
 * without the module throws at load, and the launch path (the identity migration) uses
 * these.
 */
function expoCrypto(): ExpoCrypto | null {
  if (loaded !== undefined) return loaded;
  try {
    loaded =
      Platform.OS === 'web' || requireOptionalNativeModule('ExpoCrypto')
        ? // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy: see above
          (require('expo-crypto') as ExpoCrypto)
        : null;
  } catch {
    loaded = null;
  }
  return loaded;
}

type WebCrypto = {
  getRandomValues?: <T extends Uint8Array>(a: T) => T;
  randomUUID?: () => string;
};
const globalCrypto = (): WebCrypto | undefined => (globalThis as { crypto?: WebCrypto }).crypto;

/**
 * `n` cryptographically random bytes: expo-crypto's `getRandomBytes` (a CSPRNG on iOS,
 * Android and the web, where `getRandomValues` works in an insecure context too), else
 * the runtime's `crypto.getRandomValues`. Only with neither (no such runtime ships the
 * app) does it fall back to `Math.random`.
 */
export function randomBytes(n: number): Uint8Array {
  try {
    const bytes = expoCrypto()?.getRandomBytes(n);
    if (bytes instanceof Uint8Array && bytes.length === n) return bytes;
  } catch {
    // below
  }
  const out = new Uint8Array(n);
  const g = globalCrypto();
  if (typeof g?.getRandomValues === 'function') return g.getRandomValues(out);
  for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

/** Bytes as lowercase hex. */
export function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/**
 * A random RFC 4122 v4 id: expo-crypto's `randomUUID`, else the runtime's (the web's
 * `crypto.randomUUID` exists only in a secure context: a player served over plain HTTP on
 * the LAN has none), else one built from `randomBytes`. A device-local id (a profile's),
 * never a secret.
 */
export function randomUUID(): string {
  try {
    const id = expoCrypto()?.randomUUID();
    if (typeof id === 'string' && id) return id;
  } catch {
    // below
  }
  const g = globalCrypto();
  if (typeof g?.randomUUID === 'function') {
    try {
      return g.randomUUID();
    } catch {
      // below
    }
  }
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = toHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Tests only: forget the loaded module. */
export function resetRandomForTests(): void {
  loaded = undefined;
}
