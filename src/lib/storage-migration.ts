import { type IdentityMigrationResult, migrateConnectionIdentity } from '@/lib/identity-migration';
import { getItem, setItem } from '@/lib/storage';
import { hasExistingInstall, resetStaleStorage, type StorageResetResult } from '@/stores/session';
import { defaultSchemePref, THEME_STORAGE_KEY } from '@/theme/scheme-pref';

/** What the launch migration did: the two reset axes, and the connection identity move. */
export type StorageMigrationResult = StorageResetResult & { identity: IdentityMigrationResult };

let pending: Promise<StorageMigrationResult> | null = null;

/** How many times a stored identity plan is retried before the launch goes on without it. */
const RECOVERY_ATTEMPTS = 5;
const RECOVERY_RETRY_MS = 1_000;

/**
 * The launch-time storage migration, ONE memoised run that every reader awaits (the root
 * layout before the stores hydrate, ThemeProvider before it reads the theme), so nothing
 * depends on which effect happens to run first. In order:
 *
 * 1. The theme default (`defaultSchemePref`), only when no preference is stored: the
 *    "existing install" signal (`hasExistingInstall`) is read BEFORE step 2 can rewrite
 *    the session keys. Best-effort: a failure here leaves the theme unwritten (the
 *    provider then falls back to dark) and never skips step 2.
 * 2. `resetStaleStorage` (the auth/cache version axes).
 * 3. The connection identity migration (`migrateConnectionIdentity`): legacy connection ids
 *    (the bare `server_id`) move to `<server_id>.<user_id>` with every store keyed by them,
 *    nobody signed out. Before a plan is written, a stopped run waits for next launch. Once
 *    a plan is stored (documents may be half rewritten), it retries here a few times with
 *    every reader held, so a passing storage hiccup never reaches download pruning or queue
 *    replay; a failure that persists (a playing car book, a locked keychain) stops holding
 *    the launch after `RECOVERY_ATTEMPTS` and the plan finishes on a later launch.
 */
export function migrateStorage(): Promise<StorageMigrationResult> {
  pending ??= run();
  return pending;
}

async function run(): Promise<StorageMigrationResult> {
  try {
    if ((await getItem<unknown>(THEME_STORAGE_KEY)) == null) {
      await setItem(THEME_STORAGE_KEY, defaultSchemePref(await hasExistingInstall()));
    }
  } catch (e) {
    console.warn('[storage] theme default failed', e);
  }
  const reset = await resetStaleStorage();
  let identity: IdentityMigrationResult;
  for (let attempt = 1; ; attempt++) {
    try {
      identity = await migrateConnectionIdentity();
    } catch (error) {
      identity = { status: 'aborted', step: 'read', error, recoveryRequired: true };
    }
    if (identity.status !== 'aborted') break;
    console.warn(
      '[storage] connection identity migration stopped at',
      identity.step,
      identity.error,
    );
    // The theme and every store wait on this run: never hold the launch for good.
    if (!identity.recoveryRequired || attempt >= RECOVERY_ATTEMPTS) break;
    await new Promise<void>((resolve) => setTimeout(resolve, RECOVERY_RETRY_MS));
  }
  return { ...reset, identity };
}

/** Tests only: forget the memoised run, so the next `migrateStorage` runs again. */
export function forgetStorageMigration() {
  pending = null;
}
