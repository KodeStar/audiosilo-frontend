/**
 * Whether the user swiped the app away from recents since this was last checked.
 * Only Android keeps a dismissed process cached (reopening warm-resumes the last
 * route), so only the native build implements it (see task-removed.native.ts). Web
 * and the tsc type-resolution path use this no-op.
 */
export function consumeTaskRemoved(): boolean {
  return false;
}
