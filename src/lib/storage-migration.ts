import { getItem, setItem } from '@/lib/storage';
import { hasExistingInstall, resetStaleStorage, type StorageResetResult } from '@/stores/session';
import { defaultSchemePref, THEME_STORAGE_KEY } from '@/theme/scheme-pref';

let pending: Promise<StorageResetResult> | null = null;

/**
 * The launch-time storage migration, ONE memoised run that every reader awaits (the root
 * layout before the stores hydrate, ThemeProvider before it reads the theme), so nothing
 * depends on which effect happens to run first. In order:
 *
 * 1. The theme default (`defaultSchemePref`), only when no preference is stored: the
 *    "existing install" signal (`hasExistingInstall`) is read BEFORE step 2 can rewrite
 *    the session keys. Best-effort: a failure here leaves the theme unwritten (the
 *    provider then falls back to dark) and never skips step 2.
 * 2. `resetStaleStorage` (the auth/cache version axes); its result is returned.
 */
export function migrateStorage(): Promise<StorageResetResult> {
  pending ??= run();
  return pending;
}

async function run(): Promise<StorageResetResult> {
  try {
    if ((await getItem<unknown>(THEME_STORAGE_KEY)) == null) {
      await setItem(THEME_STORAGE_KEY, defaultSchemePref(await hasExistingInstall()));
    }
  } catch (e) {
    console.warn('[storage] theme default failed', e);
  }
  return resetStaleStorage();
}

/** Tests only: forget the memoised run, so the next `migrateStorage` runs again. */
export function forgetStorageMigration() {
  pending = null;
}
