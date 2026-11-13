import * as SecureStore from 'expo-secure-store';

import {
  copyProxyHeaders,
  forgetProxyHeaders,
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

  it('copies a set to a new id, keeping one already there, and leaves the old key', async () => {
    await saveProxyHeaders('a', SET);
    await copyProxyHeaders('a', 'b');
    expect(await readProxyHeaders('b')).toEqual(SET);
    expect(await readProxyHeaders('a')).toEqual(SET); // the clean-up deletes it, later

    const other = { ...SET, headers: [{ name: 'X-Other', value: '1' }] };
    await saveProxyHeaders('a', other);
    await copyProxyHeaders('a', 'b');
    expect(await readProxyHeaders('b')).toEqual(SET);
  });

  it('rejects when the copy does not read back, the old entry untouched', async () => {
    const store = SecureStore as unknown as {
      setItemAsync: (k: string, v: string, o?: unknown) => Promise<void>;
    };
    const original = store.setItemAsync;
    await saveProxyHeaders('a', SET);
    store.setItemAsync = (k, v, o) =>
      k === proxyHeadersKey('b') ? Promise.resolve() : original(k, v, o);
    try {
      await expect(copyProxyHeaders('a', 'b')).rejects.toThrow('did not read back');
    } finally {
      store.setItemAsync = original;
    }
    expect(await readProxyHeaders('a')).toEqual(SET);
    expect(await readProxyHeaders('b')).toBeNull();
  });
});
