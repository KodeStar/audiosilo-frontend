import { randomBytes, toHex } from '@/lib/random';
import {
  deleteSecure,
  deleteSecureStrict,
  getSecureStrict,
  setSecureStrict,
} from '@/lib/secure-store';
import { chainSalted, hexOfWords, sha256, utf8, wordsOf } from '@/lib/sha256';
import { setProfileHasPin, useProfiles } from '@/stores/profiles';

/**
 * A profile's optional PIN (Phase 8, the owner's decision: off by default, device-local, 4
 * digits). Asked when switching INTO a profile that has one (and so when leaving kids
 * mode, which goes through "Who's listening?"). It keeps a person's place and books from a
 * sibling's taps, not from an attacker: anyone with the device and a browser's developer
 * tools can read a session token anyway. A forgotten PIN: remove that person from this
 * device (signing their servers out) and sign in again. No server change.
 *
 * Only a salted, iterated hash is stored, in the secure store under
 * `audiosilo.profilePin.<profileId>` as JSON `{ v: 1, salt, iterations, hash }`: `salt`
 * is 16 random bytes (hex), `hash` (hex) is SHA-256 over salt + PIN, then over salt + the
 * previous digest, `iterations` (10,000) digests in all (`chainSalted`, in chunks that let
 * the UI paint between them). Compared in constant time. The profile mirrors `hasPin` so
 * screens know without reading the secure store.
 */

export const PIN_LENGTH = 4;
const PIN_ITERATIONS = 10_000;
/** Wrong tries in a row before the prompt makes the person wait. */
const PIN_MAX_TRIES = 5;
/** How long it waits then. */
export const PIN_LOCK_MS = 30_000;

export const pinKey = (profileId: string) => `audiosilo.profilePin.${profileId}`;

type PinRecord = { v: 1; salt: string; iterations: number; hash: string };

/** A profile's stored PIN, as `readPin` read it: handed to `checkPin` so a check right
 * after the read doesn't read the secure store again. */
export type StoredPin = Readonly<PinRecord>;

/** Rounds hashed between two yields to the UI (`hashPin`). */
const ROUNDS_PER_CHUNK = 1_000;
const nextTick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Exactly four digits. */
export function isValidPin(pin: string): boolean {
  return /^\d{4}$/.test(pin);
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** The stored hash of `pin` under `saltHex` (16 bytes, hex). The rounds run in chunks with
 * a yield between them, so a slow phone keeps painting (the field, the keyboard) while a
 * PIN is set or checked. */
export async function hashPin(
  pin: string,
  saltHex: string,
  iterations = PIN_ITERATIONS,
): Promise<string> {
  const salt = fromHex(saltHex);
  if (salt.length !== 16) throw new Error('A PIN salt is 16 bytes');
  const saltWords = wordsOf(salt);
  const digest = wordsOf(sha256(concat(salt, utf8(pin))));
  for (let done = 1; done < iterations;) {
    const rounds = Math.min(ROUNDS_PER_CHUNK, iterations - done);
    chainSalted(saltWords, digest, rounds);
    done += rounds;
    if (done < iterations) await nextTick();
  }
  return hexOfWords(digest);
}

/** Equal strings, compared without stopping at the first difference. */
export function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

function parseRecord(raw: string | null): PinRecord | null {
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as Partial<PinRecord>;
    return r.v === 1 &&
      typeof r.salt === 'string' &&
      /^[0-9a-f]{32}$/.test(r.salt) &&
      typeof r.hash === 'string' &&
      /^[0-9a-f]{64}$/.test(r.hash) &&
      typeof r.iterations === 'number' &&
      Number.isSafeInteger(r.iterations) &&
      r.iterations > 0
      ? (r as PinRecord)
      : null;
  } catch {
    return null;
  }
}

/** Set (or change) a profile's PIN. Rejects a PIN that isn't four digits, and when the
 * secure store refuses the write (the profile then keeps what it had). */
export async function setPin(profileId: string, pin: string): Promise<void> {
  if (!isValidPin(pin)) throw new Error('A PIN is four digits');
  const salt = toHex(randomBytes(16));
  const record: PinRecord = {
    v: 1,
    salt,
    iterations: PIN_ITERATIONS,
    hash: await hashPin(pin, salt),
  };
  await setSecureStrict(pinKey(profileId), JSON.stringify(record));
  setProfileHasPin(profileId, true);
  attempts.delete(profileId);
}

/** Whether `pin` is the profile's PIN: against `stored` when the caller just read it
 * (`readPin`), else against what the secure store holds. False when it has none stored.
 * Rejects when the secure store can't be read. */
export async function checkPin(
  profileId: string,
  pin: string,
  stored?: StoredPin | null,
): Promise<boolean> {
  const record = stored === undefined ? await readPin(profileId) : stored;
  if (!record || !isValidPin(pin)) return false;
  return constantTimeEqual(await hashPin(pin, record.salt, record.iterations), record.hash);
}

/** The PIN stored for the profile, or null when there is none (an install restored without
 * its secure store has the mirror and no hash: the profile then has no PIN). Rejects when
 * the secure store can't be read. */
export async function readPin(profileId: string): Promise<StoredPin | null> {
  return parseRecord(await getSecureStrict(pinKey(profileId)));
}

/**
 * The PIN the secure store holds for `profile` (`readPin`), the profile's mirror
 * (`hasPin`) repaired to match on the way: the store says whether there is a PIN, never
 * the mirror alone (it is written best effort with the whole profiles document, which a
 * failed write or a second web tab holding an older document can leave wrong). Rejects,
 * changing nothing, when the store can't be read: never act on the mirror's word then.
 */
export async function readPinMirrored(profile: {
  id: string;
  hasPin?: boolean;
}): Promise<StoredPin | null> {
  const stored = await readPin(profile.id);
  if (!!stored !== !!profile.hasPin) setProfileHasPin(profile.id, !!stored);
  return stored;
}

/** Remove a profile's PIN. */
export async function clearPin(profileId: string): Promise<void> {
  await deleteSecureStrict(pinKey(profileId));
  setProfileHasPin(profileId, false);
  attempts.delete(profileId);
}

// --- Wrong tries ----------------------------------------------------------------------------

/** Wrong tries in a row per profile, in memory (a closed and reopened prompt keeps them;
 * a relaunch doesn't, which only costs the wait). */
const attempts = new Map<string, { wrong: number; until: number }>();

/** How long the prompt must still wait before another try (0: it may try now). */
export function pinLockedFor(profileId: string, now = Date.now()): number {
  const a = attempts.get(profileId);
  return a ? Math.max(0, a.until - now) : 0;
}

/** Record a try: a right one clears the count; the `PIN_MAX_TRIES`th wrong one in a row
 * starts a `PIN_LOCK_MS` wait (and the count starts again after it). */
export function notePinTry(profileId: string, right: boolean, now = Date.now()): void {
  if (right) {
    attempts.delete(profileId);
    return;
  }
  const wrong = (attempts.get(profileId)?.wrong ?? 0) + 1;
  attempts.set(
    profileId,
    wrong >= PIN_MAX_TRIES ? { wrong: 0, until: now + PIN_LOCK_MS } : { wrong, until: 0 },
  );
}

/** Tests only. */
export function resetPinTriesForTests(): void {
  attempts.clear();
}

// A profile deleted from this device (removed, or its last server signed out) takes its
// PIN with it. Best effort: a leftover hash names a profile id nothing will use again.
useProfiles.subscribe((s, prev) => {
  if (s.profiles === prev.profiles) return;
  const kept = new Set(s.profiles.map((p) => p.id));
  for (const p of prev.profiles) {
    if (!kept.has(p.id) && p.hasPin) void deleteSecure(pinKey(p.id)).catch(() => undefined);
  }
});
