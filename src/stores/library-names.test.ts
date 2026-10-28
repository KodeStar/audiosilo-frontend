import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'audiosilo.libraryNames';

// The module hydrates once per load, so each test gets a fresh copy over the storage it set.
async function load(stored?: unknown) {
  await AsyncStorage.clear();
  if (stored !== undefined) await AsyncStorage.setItem(KEY, JSON.stringify(stored));
  let mod!: typeof import('./library-names');
  let session!: typeof import('./session');
  jest.isolateModules(() => {
    mod = jest.requireActual('./library-names');
    session = jest.requireActual('./session');
  });
  return { ...mod, session };
}

const saved = async () => JSON.parse((await AsyncStorage.getItem(KEY)) ?? 'null');

describe('library names', () => {
  it('keeps the names a server lists, by connection, beside the stored ones', async () => {
    const { useLibraryNames } = await load({ names: { b: { '3': 'Podcasts' } } });
    await useLibraryNames.getState().remember('a', [
      { id: 1, name: 'Books' },
      { id: 2, name: 'Kids' },
    ]);
    expect(useLibraryNames.getState().names).toEqual({
      a: { '1': 'Books', '2': 'Kids' },
      b: { '3': 'Podcasts' },
    });
    expect(await saved()).toEqual({
      names: { a: { '1': 'Books', '2': 'Kids' }, b: { '3': 'Podcasts' } },
    });
  });

  it("replaces a connection's names with its new list (a removed library goes)", async () => {
    const { useLibraryNames } = await load({ names: { a: { '1': 'Books', '2': 'Old' } } });
    await useLibraryNames.getState().remember('a', [{ id: 1, name: 'Audiobooks' }]);
    expect(useLibraryNames.getState().names.a).toEqual({ '1': 'Audiobooks' });
  });

  it('drops what does not parse', async () => {
    const { useLibraryNames } = await load({
      names: { a: { '1': 'Books', '2': 7, '3': '' }, b: 'nope' },
    });
    await useLibraryNames.getState().hydrate();
    expect(useLibraryNames.getState().names).toEqual({ a: { '1': 'Books' } });
  });

  it('starts empty from a corrupt document', async () => {
    const { useLibraryNames } = await load('nope');
    await useLibraryNames.getState().hydrate();
    expect(useLibraryNames.getState().names).toEqual({});
  });

  it("forgets a removed connection's names", async () => {
    const { useLibraryNames } = await load({
      names: { a: { '1': 'Books' }, b: { '1': 'Other' } },
    });
    await useLibraryNames.getState().forget('a');
    expect(useLibraryNames.getState().names).toEqual({ b: { '1': 'Other' } });
    expect(await saved()).toEqual({ names: { b: { '1': 'Other' } } });
  });

  it('rememberLibraryNames ignores a missing list and never throws', async () => {
    const { rememberLibraryNames, useLibraryNames } = await load();
    expect(() => rememberLibraryNames('a', undefined as never)).not.toThrow();
    await useLibraryNames.getState().hydrate();
    expect(useLibraryNames.getState().names).toEqual({});
  });
});
