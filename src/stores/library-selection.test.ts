import type AsyncStorageType from '@react-native-async-storage/async-storage';

import type * as SelectionModule from '@/stores/library-selection';
import type * as SessionModule from '@/stores/session';

const KEY = 'audiosilo.librarySelection';

// Hydration is MODULE state (`persistedDocument`): each test gets a fresh registry.
let AsyncStorage: typeof AsyncStorageType;
let mod: typeof SelectionModule;
let session: typeof SessionModule;
function load() {
  jest.resetModules();
  /* eslint-disable @typescript-eslint/no-require-imports */
  AsyncStorage = require('@react-native-async-storage/async-storage').default;
  mod = require('@/stores/library-selection');
  session = require('@/stores/session');
  /* eslint-enable @typescript-eslint/no-require-imports */
}

describe('library selection store', () => {
  beforeEach(load);

  it('persists a pick and restores it', async () => {
    await mod.useLibrarySelection.getState().hydrate();
    mod.useLibrarySelection.getState().select({ connectionId: 'a', libraryId: 2 });
    expect(JSON.parse((await AsyncStorage.getItem(KEY))!)).toEqual({
      selection: { connectionId: 'a', libraryId: 2 },
    });

    const raw = await AsyncStorage.getItem(KEY);
    load();
    await AsyncStorage.setItem(KEY, raw!);
    await mod.useLibrarySelection.getState().hydrate();
    expect(mod.useLibrarySelection.getState().selection).toEqual({
      connectionId: 'a',
      libraryId: 2,
    });
  });

  it('lets a pick made before hydration win', async () => {
    await AsyncStorage.setItem(
      KEY,
      JSON.stringify({ selection: { connectionId: 'a', libraryId: 1 } }),
    );
    mod.useLibrarySelection.getState().select({ connectionId: 'b', libraryId: 4 });
    await mod.useLibrarySelection.getState().hydrate();
    expect(mod.useLibrarySelection.getState().selection).toEqual({
      connectionId: 'b',
      libraryId: 4,
    });
  });

  it('ignores a corrupt stored value', async () => {
    await AsyncStorage.setItem(
      KEY,
      JSON.stringify({ selection: { connectionId: 3, libraryId: 'x' } }),
    );
    await mod.useLibrarySelection.getState().hydrate();
    expect(mod.useLibrarySelection.getState().selection).toBeNull();
  });

  it("drops a removed connection's pick and keeps another's", async () => {
    await mod.useLibrarySelection.getState().hydrate();
    mod.useLibrarySelection.getState().select({ connectionId: 'a', libraryId: 2 });
    await session.useSession.getState().removeConnection('b');
    expect(mod.useLibrarySelection.getState().selection).not.toBeNull();
    await session.useSession.getState().removeConnection('a');
    expect(mod.useLibrarySelection.getState().selection).toBeNull();
    expect(JSON.parse((await AsyncStorage.getItem(KEY))!)).toEqual({ selection: null });
  });
});

describe('resolveLibrarySelection', () => {
  beforeAll(load);
  const group = (
    connectionId: string,
    libraryIds: number[],
    status: 'loading' | 'ready' | 'error' = 'ready',
  ) => ({ connectionId, connectionName: connectionId, libraryIds, status });

  it('keeps a pick that still exists', () => {
    expect(
      mod.resolveLibrarySelection({ connectionId: 'b', libraryId: 7 }, [
        group('a', [1]),
        group('b', [3, 7]),
      ]),
    ).toEqual({ connectionId: 'b', libraryId: 7 });
  });

  it("keeps a pick while its server's list is loading or failing", () => {
    const pick = { connectionId: 'b', libraryId: 7 };
    expect(mod.resolveLibrarySelection(pick, [group('a', [1]), group('b', [], 'loading')])).toBe(
      pick,
    );
    expect(mod.resolveLibrarySelection(pick, [group('a', [1]), group('b', [], 'error')])).toBe(
      pick,
    );
  });

  it('falls back to the first library when the pick is gone', () => {
    const first = { connectionId: 'a', libraryId: 1 };
    expect(
      mod.resolveLibrarySelection({ connectionId: 'gone', libraryId: 1 }, [group('a', [1, 2])]),
    ).toEqual(first);
    expect(mod.resolveLibrarySelection(null, [group('a', [1, 2])])).toEqual(first);
  });

  it('stays on the picked server when the pick is gone and it lists another library', () => {
    expect(
      mod.resolveLibrarySelection({ connectionId: 'b', libraryId: 9 }, [
        group('a', [1, 2]),
        group('b', [3]),
      ]),
    ).toEqual({ connectionId: 'b', libraryId: 3 });
    // A picked server that answered with no library at all: the first server that has one.
    expect(
      mod.resolveLibrarySelection({ connectionId: 'b', libraryId: 9 }, [
        group('a', [1, 2]),
        group('b', []),
      ]),
    ).toEqual({ connectionId: 'a', libraryId: 1 });
  });

  // fe#142: with two servers, a slow, failing or signed-out one used to hand the Library to
  // the other server's books without a word.
  describe('never another server in place of one that has not answered', () => {
    const b3 = { connectionId: 'b', libraryId: 3 };

    it('with no pick, waits for the first server while its list is loading', () => {
      expect(mod.resolveLibrary(null, [group('a', [], 'loading'), group('b', [3])])).toEqual({
        selection: null,
        waitingOn: 'a',
      });
    });

    it('with no pick, stays on the first server when its list failed (down, or signed out)', () => {
      expect(mod.resolveLibrary(null, [group('a', [], 'error'), group('b', [3])])).toEqual({
        selection: null,
        waitingOn: 'a',
      });
      expect(mod.resolveLibrarySelection(null, [group('a', [], 'error'), group('b', [3])])).toBe(
        null,
      );
    });

    it("keeps the stored pick on its own server while that server's list is loading or failed", () => {
      const pick = { connectionId: 'a', libraryId: 1 };
      for (const status of ['loading', 'error'] as const) {
        expect(mod.resolveLibrary(pick, [group('a', [], status), group('b', [3])])).toEqual({
          selection: pick,
          waitingOn: null,
        });
      }
    });

    it('passes over only a server that answered with no libraries', () => {
      expect(mod.resolveLibrary(null, [group('a', []), group('b', [3])])).toEqual({
        selection: b3,
        waitingOn: null,
      });
      // The next one that has not answered is then the one waited for.
      expect(
        mod.resolveLibrary(null, [group('a', []), group('x', [], 'error'), group('b', [3])]),
      ).toEqual({ selection: null, waitingOn: 'x' });
    });

    it('a pick whose connection is gone waits for the first server too', () => {
      expect(
        mod.resolveLibrary({ connectionId: 'gone', libraryId: 1 }, [
          group('a', [], 'loading'),
          group('b', [3]),
        ]),
      ).toEqual({ selection: null, waitingOn: 'a' });
    });

    it('has nothing to show or wait for once every server answered with none', () => {
      expect(mod.resolveLibrary(null, [group('a', []), group('b', [])])).toEqual({
        selection: null,
        waitingOn: null,
      });
      expect(mod.resolveLibrary(null, [])).toEqual({ selection: null, waitingOn: null });
    });

    it('once the first server answers, its library shows (no session-long detour)', () => {
      expect(mod.resolveLibrary(null, [group('a', [1]), group('b', [3])])).toEqual({
        selection: { connectionId: 'a', libraryId: 1 },
        waitingOn: null,
      });
    });
  });

  it('keeps showing a fallback when an earlier server lists a library later', () => {
    // Shown while the first server had none; it has one now.
    const shown = { connectionId: 'b', libraryId: 3 };
    expect(mod.resolveLibrarySelection(null, [group('a', [1]), group('b', [3])], shown)).toBe(
      shown,
    );
    // A stored pick still wins; a shown library that is gone gives way.
    const pick = { connectionId: 'a', libraryId: 1 };
    expect(mod.resolveLibrarySelection(pick, [group('a', [1]), group('b', [3])], shown)).toBe(pick);
    expect(mod.resolveLibrarySelection(null, [group('a', [1]), group('b', [4])], shown)).toEqual(
      pick,
    );
  });
});
