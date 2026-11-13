import * as SecureStore from 'expo-secure-store';

import {
  forgetProxyHeaders,
  moveProxyHeaders,
  proxyHeadersKey,
  readProxyHeaders,
  saveProxyHeaders,
} from './proxy-headers-store';

const SET = {
  origin: 'https://books.example.com',
  headers: [{ name: 'CF-Access-Client-Secret', value: 'proxy-secret' }],
};

describe('proxy headers storage (secure-store, beside the token)', () => {
  beforeEach(async () => {
    await Promise.all(['a', 'b'].map((id) => forgetProxyHeaders(id)));
  });

  it('saves, reads back and deletes a set under the connection key', async () => {
    await saveProxyHeaders('a', SET);
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
      'audiosilo.proxy-headers.a',
      expect.any(String),
      expect.anything(),
    );
    expect(await readProxyHeaders('a')).toEqual(SET);
    await saveProxyHeaders('a', null);
    expect(await readProxyHeaders('a')).toBeNull();
    await saveProxyHeaders('a', { ...SET, headers: [] });
    expect(await SecureStore.getItemAsync(proxyHeadersKey('a'))).toBeNull();
  });

  it('reads a damaged or foreign item as none, dropping headers that are not valid', async () => {
    await SecureStore.setItemAsync(proxyHeadersKey('a'), '{not json');
    expect(await readProxyHeaders('a')).toBeNull();
    await SecureStore.setItemAsync(
      proxyHeadersKey('a'),
      JSON.stringify({
        origin: SET.origin,
        headers: [
          { name: 'Authorization', value: 'x' },
          ...SET.headers,
          { name: 'X-Bad', value: 'a\nb' },
        ],
      }),
    );
    expect(await readProxyHeaders('a')).toEqual(SET);
  });

  it('rejects when the platform refuses the read (the hydrate fails on it)', async () => {
    const store = SecureStore as unknown as { getItemAsync: (k: string) => Promise<string | null> };
    const original = store.getItemAsync;
    store.getItemAsync = () => Promise.reject(new Error('keychain locked'));
    try {
      await expect(readProxyHeaders('a')).rejects.toThrow('keychain locked');
    } finally {
      store.getItemAsync = original;
    }
  });

  it('moves a set to a new id, keeping one already there, and never leaves the old key', async () => {
    await saveProxyHeaders('a', SET);
    await moveProxyHeaders('a', 'b');
    expect(await readProxyHeaders('a')).toBeNull();
    expect(await readProxyHeaders('b')).toEqual(SET);

    const other = { ...SET, headers: [{ name: 'X-Other', value: '1' }] };
    await saveProxyHeaders('a', other);
    await moveProxyHeaders('a', 'b');
    expect(await readProxyHeaders('a')).toBeNull();
    expect(await readProxyHeaders('b')).toEqual(SET);
  });
});
