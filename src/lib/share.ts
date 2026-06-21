import { Share } from 'react-native';

/**
 * Share a string via the OS share sheet, swallowing the two non-error outcomes —
 * the user dismissing the sheet and sharing being unavailable on the platform —
 * so callers don't each repeat the same try/catch.
 */
export async function shareText(message: string): Promise<void> {
  try {
    await Share.share({ message });
  } catch {
    // user dismissed, or sharing is unavailable on this platform
  }
}
