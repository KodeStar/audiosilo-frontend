import AsyncStorage from '@react-native-async-storage/async-storage';
import { createHash } from 'crypto';

import { getSecure, setSecure } from '@/lib/secure-store';
import { profileOf, resetProfilesForTests, useProfiles } from '@/stores/profiles';
import { useSession } from '@/stores/session';

import {
  checkPin,
  clearPin,
  constantTimeEqual,
  hashPin,
  hasStoredPin,
  isValidPin,
  notePinTry,
  PIN_LOCK_MS,
  pinKey,
  pinLockedFor,
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

const profileId = () => profileOf(conn.id)!.id;

describe('hashPin', () => {
  it('is SHA-256 over salt + PIN, then over salt + the previous digest', () => {
    const salt = '00112233445566778899aabbccddeeff';
    const s = Buffer.from(salt, 'hex');
    let d = createHash('sha256')
      .update(Buffer.concat([s, Buffer.from('1234')]))
      .digest();
    for (let i = 1; i < 25; i++)
      d = createHash('sha256')
        .update(Buffer.concat([s, d]))
        .digest();
    expect(hashPin('1234', salt, 25)).toBe(d.toString('hex'));
  });

  it('differs by salt and by PIN', () => {
    const a = '00'.repeat(16);
    const b = '01'.repeat(16);
    expect(hashPin('1234', a, 3)).not.toBe(hashPin('1234', b, 3));
    expect(hashPin('1234', a, 3)).not.toBe(hashPin('1235', a, 3));
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
    expect(record.hash).toBe(hashPin('4821', record.salt));
    expect(profileOf(conn.id)?.hasPin).toBe(true);
    expect(await hasStoredPin(profileId())).toBe(true);
  });

  it('checks the right PIN and refuses a wrong one', async () => {
    await setPin(profileId(), '4821');
    expect(await checkPin(profileId(), '4821')).toBe(true);
    expect(await checkPin(profileId(), '4812')).toBe(false);
    expect(await checkPin(profileId(), '48210')).toBe(false);
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
    expect(await hasStoredPin(profileId())).toBe(false);
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
