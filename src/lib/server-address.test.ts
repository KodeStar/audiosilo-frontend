import {
  type AddressedConnection,
  addressKind,
  chooseAddress,
  fallbackAddress,
  isOwnAddress,
  mergeAddresses,
  pickAddress,
  sameAddresses,
  sameUrl,
  streamBase,
} from '@/lib/server-address';

const HOME = 'http://192.168.1.20:8080';
const AWAY = 'https://books.example.com';

const conn = (over: Partial<AddressedConnection> = {}): AddressedConnection => ({
  id: 'srv-a',
  serverUrl: AWAY,
  addresses: { home: HOME, away: AWAY },
  ...over,
});

describe('sameUrl / sameAddresses', () => {
  it('ignores trailing slashes only', () => {
    expect(sameUrl('https://h/', 'https://h')).toBe(true);
    expect(sameUrl('https://h/a', 'https://h/b')).toBe(false);
  });
  it('compares both addresses, absent = empty', () => {
    expect(sameAddresses(undefined, {})).toBe(true);
    expect(sameAddresses({ home: HOME }, { home: HOME })).toBe(true);
    expect(sameAddresses({ home: HOME }, { home: HOME, away: AWAY })).toBe(false);
  });
});

describe('mergeAddresses', () => {
  it('keeps what it knew when nothing was said', () => {
    expect(mergeAddresses({ home: HOME }, undefined)).toEqual({ home: HOME });
    expect(mergeAddresses(undefined, undefined)).toBeUndefined();
  });
  it('takes a new home and away', () => {
    expect(mergeAddresses({ home: 'http://10.0.0.2' }, { home: HOME, away: AWAY })).toEqual({
      home: HOME,
      away: AWAY,
    });
  });
  it('keeps the known home when the answer lacks one (read from outside the home network)', () => {
    expect(mergeAddresses({ home: HOME, away: AWAY }, { away: AWAY })).toEqual({
      home: HOME,
      away: AWAY,
    });
  });
  it('drops an away address the server no longer has (its answer is the configuration)', () => {
    expect(mergeAddresses({ home: HOME, away: AWAY }, {})).toEqual({ home: HOME });
    expect(mergeAddresses({ away: AWAY }, {})).toBeUndefined();
  });
  it('drops a kept home that became the away address', () => {
    expect(mergeAddresses({ home: AWAY }, { away: AWAY })).toEqual({ away: AWAY });
  });
});

describe('chooseAddress (the pick rule)', () => {
  it('uses the paired URL when there is no home address', () => {
    expect(chooseAddress(conn({ addresses: { away: 'https://other' } }), null)).toBe(AWAY);
    expect(chooseAddress(conn({ addresses: undefined }), 'srv-a')).toBe(AWAY);
  });
  it('uses home only when it answered with this server_id', () => {
    expect(chooseAddress(conn(), 'srv-a')).toBe(HOME);
  });
  it('never uses a home address that answered as another server', () => {
    expect(chooseAddress(conn(), 'someone-elses-box')).toBe(AWAY);
  });
  it('falls back to away, else the paired URL, when home did not answer', () => {
    expect(chooseAddress(conn(), null)).toBe(AWAY);
    expect(chooseAddress(conn({ serverUrl: HOME, addresses: { home: HOME } }), null)).toBe(HOME);
    expect(
      chooseAddress(conn({ serverUrl: 'https://paired', addresses: { home: HOME } }), null),
    ).toBe('https://paired');
  });
  it('a device paired at home leaves for the away address', () => {
    expect(chooseAddress(conn({ serverUrl: HOME }), null)).toBe(AWAY);
    expect(fallbackAddress(conn({ serverUrl: HOME }))).toBe(AWAY);
  });
});

describe('pickAddress', () => {
  it('asks only the home address, and only when there is one', async () => {
    const probe = jest.fn(async () => 'srv-a');
    expect(await pickAddress(conn(), probe)).toBe(HOME);
    expect(probe).toHaveBeenCalledWith(HOME);
    probe.mockClear();
    expect(await pickAddress(conn({ addresses: { away: AWAY } }), probe)).toBe(AWAY);
    expect(probe).not.toHaveBeenCalled();
  });
  it('treats a throwing probe as no answer', async () => {
    const probe = jest.fn(async (): Promise<string | null> => {
      throw new Error('boom');
    });
    expect(await pickAddress(conn(), probe)).toBe(AWAY);
  });
});

describe('addressKind / isOwnAddress', () => {
  it('names the address in use', () => {
    expect(addressKind(HOME, conn())).toBe('home');
    expect(addressKind(`${AWAY}/`, conn())).toBe('away');
    expect(addressKind('https://paired', conn({ serverUrl: 'https://paired' }))).toBe('paired');
    expect(addressKind(AWAY, conn({ addresses: undefined }))).toBe('paired');
  });
  it('knows the connection own addresses', () => {
    const c = conn({ serverUrl: 'https://paired' });
    expect(isOwnAddress('https://paired', c)).toBe(true);
    expect(isOwnAddress(HOME, c)).toBe(true);
    expect(isOwnAddress(AWAY, c)).toBe(true);
    expect(isOwnAddress('http://10.0.0.9', c)).toBe(false);
  });
});

describe('streamBase', () => {
  it('reads the base of a streamed track, keeping a path prefix', () => {
    expect(streamBase(`${HOME}/api/v1/libraries/1/stream?path=a.mp3&token=t`)).toBe(HOME);
    expect(streamBase('https://h/audiosilo/api/v1/libraries/1/stream?path=a')).toBe(
      'https://h/audiosilo',
    );
  });
  it('is null for a downloaded file', () => {
    expect(streamBase('file:///data/downloads/c1/1/book/a.mp3')).toBeNull();
    expect(streamBase('https://h/elsewhere.mp3')).toBeNull();
  });
});
