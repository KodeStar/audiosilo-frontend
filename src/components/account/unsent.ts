import type { TFunction } from 'i18next';

import { unsentBookmarks } from '@/playback/annotation-outbox';
import { unsentListens } from '@/playback/listening-outbox';

/** What this device holds for a server that hasn't reached it: lost when the server is
 * signed out or removed. */
export type Unsent = { listens: number; bookmarks: number };

/** Before a sign-out or removal is confirmed: Sync v2's listens and the waiting bookmarks
 * (fe#356) each get a send while the server reads as reachable, then what is still unsent. */
export async function unsentBeforeSignOut(connectionId: string): Promise<Unsent> {
  const [listens, bookmarks] = await Promise.all([
    unsentListens(connectionId).catch(() => 0),
    unsentBookmarks(connectionId).catch(() => 0),
  ]);
  return { listens, bookmarks };
}

/** Whether anything would be lost. */
export const anyUnsent = (u: Unsent) => u.listens > 0 || u.bookmarks > 0;

/** What would be lost, a sentence per kind ("3 listens haven't synced to Home and will be
 * lost."): the remove confirms' words, and the sign-out confirm's before its question. */
export function unsentLines(t: TFunction, u: Unsent, name: string): string[] {
  const lines: string[] = [];
  if (u.listens > 0) {
    lines.push(t('account.connections.removeConfirm.unsynced', { count: u.listens, name }));
  }
  if (u.bookmarks > 0) {
    lines.push(
      t('account.connections.removeConfirm.unsyncedBookmarks', { count: u.bookmarks, name }),
    );
  }
  return lines;
}

/** The sign-out confirm's words for what would be lost: the listens alone as before ("3
 * listens haven't synced to Home. Sign out anyway?"), else a sentence per kind and the
 * question. */
export function signOutUnsentCopy(
  t: TFunction,
  u: Unsent | null,
  server: string,
): { title: string; message: string } {
  if (!u) return { title: '', message: '' };
  if (u.bookmarks === 0) {
    return {
      title: t('account.signOut.unsyncedTitle'),
      message: t('account.signOut.unsynced', { count: u.listens, server }),
    };
  }
  return {
    title: t('account.signOut.unsyncedAnyTitle'),
    message: [...unsentLines(t, u, server), t('account.signOut.anyway')].join(' '),
  };
}
