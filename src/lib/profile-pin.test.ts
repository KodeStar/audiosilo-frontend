import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { toHex } from '@/lib/random';
import { getSecure, setSecure } from '@/lib/secure-store';
import { profileOf, resetProfilesForTests, useProfiles } from '@/stores/profiles';
import { useSession } from '@/stores/session';

import {
  checkPin,
  clearPin,
  constantTimeEqual,
  hashPin,
  isValidPin,
  notePinTry,
  PIN_LOCK_MS,
  pinKey,
  pinLockedFor,
  readPin,
  resetPinTriesForTests,
  setPin,
} from './profile-pin';

const conn = {
  id: 's.1',
  serverId: 's',
  serverUrl: 'https://s',
  name: 'S',
  token: 't',
  user: {
    id: 1,
    username: 'chris',
    role: 'user' as const,
    disabled: false,
    has_password: true,
    has_recovery: false,
  },
};

beforeEach(async () => {
  await AsyncStorage.clear();
  resetProfilesForTests();
  resetPinTriesForTests();
  useSession.setState({
    status: 'authenticated',
    connections: [conn],
    defaultConnectionId: conn.id,
    user: conn.user,
  });
  await useProfiles.getState().hydrate();
});

// Node's own SHA-256, as the reference (the app's tsconfig has no node types).
type NodeHash = { update: (d: Uint8Array) => NodeHash; digest: () => Uint8Array };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createHash } = require('crypto') as { createHash: (alg: 'sha256') => NodeHash };
const bytes = (hex: string) => new Uint8Array(hex.match(/../g)!.map((h) => parseInt(h, 16)));
const join = (a: Uint8Array, b: Uint8Array) => new Uint8Array([...a, ...b]);

const profileId = () => profileOf(conn.id)!.id;

describe('hashPin', () => {
  it('is SHA-256 over salt + PIN, then over salt + the previous digest', async () => {
    const salt = '00112233445566778899aabbccddeeff';
    const s = bytes(salt);
    let d = createHash('sha256')
      .update(join(s, new TextEncoder().encode('1234')))
      .digest();
    for (let i = 1; i < 25; i++) d = createHash('sha256').update(join(s, d)).digest();
    expect(await hashPin('1234', salt, 25)).toBe(toHex(d));
    // Across chunk boundaries (1,000 rounds each) too.
    for (let i = 25; i < 2_500; i++) d = createHash('sha256').update(join(s, d)).digest();
    expect(await hashPin('1234', salt, 2_500)).toBe(toHex(d));
  });

  it('differs by salt and by PIN', async () => {
    const a = '00'.repeat(16);
    const b = '01'.repeat(16);
    expect(await hashPin('1234', a, 3)).not.toBe(await hashPin('1234', b, 3));
    expect(await hashPin('1234', a, 3)).not.toBe(await hashPin('1235', a, 3));
  });

  it('lets the UI run between chunks of rounds', async () => {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 0);
    try {
      await hashPin('1234', '00'.repeat(16), 10_000);
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeGreaterThan(0);
  });
});

describe('PIN storage', () => {
  it('stores only a salted 10,000-round hash and mirrors hasPin', async () => {
    await setPin(profileId(), '4821');
    const raw = await getSecure(pinKey(profileId()));
    const record = JSON.parse(raw!);
    expect(record).toEqual({
      v: 1,
      salt: expect.stringMatching(/^[0-9a-f]{32}$/),
      iterations: 10_000,
      hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(raw).not.toContain('4821');
    expect(record.hash).toBe(await hashPin('4821', record.salt));
    expect(profileOf(conn.id)?.hasPin).toBe(true);
    expect(await readPin(profileId())).toEqual(record);
  });

  it('checks the right PIN and refuses a wrong one', async () => {
    await setPin(profileId(), '4821');
    expect(await checkPin(profileId(), '4821')).toBe(true);
    expect(await checkPin(profileId(), '4812')).toBe(false);
    expect(await checkPin(profileId(), '48210')).toBe(false);
  });

  it('checks against a PIN the caller already read, without reading it again', async () => {
    await setPin(profileId(), '4821');
    const stored = await readPin(profileId());
    const SecureStore = jest.requireMock('expo-secure-store') as { getItemAsync: jest.Mock };
    const reads = SecureStore.getItemAsync.mock.calls.length;
    expect(await checkPin(profileId(), '4821', stored)).toBe(true);
    expect(await checkPin(profileId(), '4812', stored)).toBe(false);
    expect(await checkPin(profileId(), '4821', null)).toBe(false);
    expect(SecureStore.getItemAsync.mock.calls.length).toBe(reads);
  });

  it('a new salt each time the PIN is set', async () => {
    await setPin(profileId(), '1111');
    const first = await getSecure(pinKey(profileId()));
    await setPin(profileId(), '1111');
    expect(await getSecure(pinKey(profileId()))).not.toBe(first);
  });

  it('refuses a PIN that is not four digits', async () => {
    await expect(setPin(profileId(), '12a4')).rejects.toThrow();
    expect(isValidPin('1234')).toBe(true);
    for (const bad of ['123', '12345', 'abcd', ' 1234', '']) expect(isValidPin(bad)).toBe(false);
    expect(profileOf(conn.id)?.hasPin).toBeUndefined();
  });

  it('clears the PIN and the mirror', async () => {
    await setPin(profileId(), '4821');
    await clearPin(profileId());
    expect(await getSecure(pinKey(profileId()))).toBeNull();
    expect(profileOf(conn.id)?.hasPin).toBeUndefined();
    expect(await checkPin(profileId(), '4821')).toBe(false);
  });

  it('a corrupt record counts as no PIN', async () => {
    await setSecure(pinKey(profileId()), '{"v":1,"salt":"zz"}');
    expect(await readPin(profileId())).toBeNull();
    expect(await checkPin(profileId(), '1234')).toBe(false);
  });

  it('a deleted profile takes its PIN with it', async () => {
    const id = profileId();
    await setPin(id, '4821');
    await useSession.getState().removeConnection(conn.id);
    await Promise.resolve();
    expect(await getSecure(pinKey(id))).toBeNull();
  });
});

describe('wrong tries', () => {
  it('five wrong in a row wait 30 seconds; a right one clears the count', () => {
    for (let i = 0; i < 4; i++) notePinTry('p', false, 1000);
    expect(pinLockedFor('p', 1000)).toBe(0);
    notePinTry('p', true, 1000);
    for (let i = 0; i < 4; i++) notePinTry('p', false, 1000);
    expect(pinLockedFor('p', 1000)).toBe(0);
    notePinTry('p', false, 1000);
    expect(pinLockedFor('p', 1000)).toBe(PIN_LOCK_MS);
    expect(pinLockedFor('p', 1000 + PIN_LOCK_MS - 1)).toBe(1);
    expect(pinLockedFor('p', 1000 + PIN_LOCK_MS)).toBe(0);
    expect(pinLockedFor('other', 1000)).toBe(0);
  });
});

describe('constantTimeEqual', () => {
  it('compares whole strings', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
  });
});

describe('finding 10: web PIN storage fails closed', () => {
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const os = Platform.OS;
  afterEach(() => {
    Platform.OS = os;
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });

  it.each(['throws', 'silently drops'])('refuses a PIN write that %s', async (failure) => {
    Platform.OS = 'web';
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        setItem: () => {
          if (failure === 'throws') throw new Error('quota');
        },
        getItem: () => null,
      },
    });
    await expect(setPin(profileId(), '1234')).rejects.toThrow();
    expect(profileOf(conn.id)?.hasPin).not.toBe(true);
  });

  it('distinguishes an unreadable hash from an absent PIN', async () => {
    Platform.OS = 'web';
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: () => {
          throw new Error('read denied');
        },
      },
    });
    await expect(readPin(profileId())).rejects.toThrow('read denied');
  });
});
