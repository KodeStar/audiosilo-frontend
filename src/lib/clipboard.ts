import { shareText } from './share';

/**
 * Copy a string to the clipboard, returning whether it actually landed on the
 * clipboard. The app has no clipboard native module (like the recovery-code flow,
 * it deliberately avoids one), so:
 *
 * - On the web the Clipboard API is available: write directly and report `true`.
 * - Otherwise (native, or a browser without a usable Clipboard API) fall back to
 *   the OS share sheet - whose first action is Copy on every platform - and report
 *   `false` so the caller shows no "Copied" confirmation for an action it can't
 *   confirm.
 *
 * Either way the caller should also keep the secret selectable so it can be copied
 * by hand as a last resort.
 */
export async function copyText(text: string): Promise<boolean> {
  const clipboard = globalThis.navigator?.clipboard;
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // Clipboard write can reject (no permission / not focused); fall through to share.
    }
  }
  await shareText(text);
  return false;
}
