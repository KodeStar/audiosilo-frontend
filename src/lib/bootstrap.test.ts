const calls: string[] = [];
const mockMigrate = jest.fn(async () => {
  calls.push('migrate');
  return { authReset: false, cacheReset: false };
});
jest.mock('@/lib/storage-migration', () => ({ migrateStorage: () => mockMigrate() }));

const mockClearAll = jest.fn(async () => {
  calls.push('clearAll');
});
jest.mock('@/downloads/engine', () => ({ engine: { clearAll: () => mockClearAll() } }));

const hydrate = (name: string) =>
  jest.fn(async () => {
    calls.push(name);
  });
const mockHydrates = {
  session: hydrate('session'),
  settings: hydrate('settings'),
  downloads: hydrate('downloads'),
  series: hydrate('series'),
  library: hydrate('library'),
};
jest.mock('@/stores/session', () => ({
  useSession: { getState: () => ({ hydrate: mockHydrates.session }) },
}));
jest.mock('@/stores/settings', () => ({
  useSettings: { getState: () => ({ hydrate: mockHydrates.settings }) },
}));
jest.mock('@/downloads/store', () => ({
  useDownloads: { getState: () => ({ hydrate: mockHydrates.downloads }) },
}));
jest.mock('@/stores/series-orderings', () => ({
  useSeriesOrderings: { getState: () => ({ hydrate: mockHydrates.series }) },
}));
const mockRestoreLanguage = jest.fn(async () => {
  calls.push('language');
});
jest.mock('@/i18n/language-provider', () => ({ restoreLanguage: () => mockRestoreLanguage() }));
jest.mock('@/stores/library-selection', () => ({
  useLibrarySelection: { getState: () => ({ hydrate: mockHydrates.library }) },
}));

/* eslint-disable import/first */
import { bootstrapPlayback, forgetBootstrap } from './bootstrap';
/* eslint-enable import/first */

beforeEach(() => {
  calls.length = 0;
  jest.clearAllMocks();
  forgetBootstrap();
});

describe('bootstrapPlayback', () => {
  it('migrates storage, then hydrates every store, in the root layout’s order', async () => {
    await bootstrapPlayback();
    expect(calls.filter((c) => c !== 'language')).toEqual([
      'migrate',
      'session',
      'settings',
      'downloads',
      'series',
      'library',
    ]);
    expect(mockClearAll).not.toHaveBeenCalled();
  });

  // The car's headless task has no LanguageProvider: the launch steps apply the language.
  it('applies the listener’s language alongside, and resolves only once it is applied', async () => {
    let applied: () => void = () => {};
    mockRestoreLanguage.mockImplementationOnce(
      () => new Promise<void>((resolve) => (applied = resolve)),
    );
    let done = false;
    const run = bootstrapPlayback().then(() => (done = true));
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(mockHydrates.library).toHaveBeenCalled();
    expect(done).toBe(false);
    applied();
    await run;
    expect(mockRestoreLanguage).toHaveBeenCalledTimes(1);
  });

  it('runs the steps once: a second caller (the headless task, then the layout) shares the run', async () => {
    const first = bootstrapPlayback();
    const second = bootstrapPlayback();
    expect(second).toBe(first);
    await Promise.all([first, second]);
    await bootstrapPlayback();
    expect(mockMigrate).toHaveBeenCalledTimes(1);
    for (const h of Object.values(mockHydrates)) expect(h).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['auth', { authReset: true, cacheReset: false }],
    ['cache', { authReset: false, cacheReset: true }],
  ])('wipes the downloads root before hydrating after a %s reset', async (_axis, result) => {
    mockMigrate.mockImplementationOnce(async () => {
      calls.push('migrate');
      return result;
    });
    await bootstrapPlayback();
    expect(calls.filter((c) => c !== 'language').slice(0, 3)).toEqual([
      'migrate',
      'clearAll',
      'session',
    ]);
  });

  it('still hydrates when the migration fails, and settles when a store fails', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockMigrate.mockImplementationOnce(async () => {
      throw new Error('keychain');
    });
    mockHydrates.downloads.mockImplementationOnce(async () => {
      throw new Error('disk');
    });
    await expect(bootstrapPlayback()).resolves.toBeUndefined();
    expect(mockHydrates.session).toHaveBeenCalled();
    expect(mockHydrates.library).toHaveBeenCalled();
    warn.mockRestore();
  });
});
