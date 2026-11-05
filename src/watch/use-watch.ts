import type { TFunction } from 'i18next';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';

import { useServerInfo } from '@/api/hooks';
import { useOptionalApi } from '@/api/provider';
import { pairingError } from '@/components/account/use-pairing';
import { toast } from '@/components/ui/toast';
import { useSession } from '@/stores/session';

import { watchLink } from './link';
import { sendBookToWatch, WatchSendError } from './send';
import { sendToWatchVisible, type WatchableBook, type WatchStatus } from './watch-model';
import { startWatchLink, useWatchStore } from './watch-store';

/** The watch as this phone knows it, followed while the app runs. */
export function useWatchStatus(): WatchStatus {
  useEffect(startWatchLink, []);
  return useWatchStore((s) => s.status);
}

/** What a failed send says: the watch's fault, or the server's when the token was the problem. */
export function watchErrorText(e: unknown, server: string, t: TFunction): string {
  return e instanceof WatchSendError ? t('account.watch.sendFailed') : pairingError(e, server, t);
}

type SendToWatch = (book: WatchableBook) => void;

function useSendToWatchLinked(connectionId: string, libraryId: number): SendToWatch | null {
  const { t } = useTranslation();
  useEffect(startWatchLink, []);
  // Only what a row needs, so the watch's own news (a book's progress, events waiting) re-renders
  // no book row.
  const link = useWatchStore(
    useShallow((s) => ({ paired: s.status.paired, installed: s.status.installed })),
  );
  const connection = useSession((s) => s.connections.find((c) => c.id === connectionId) ?? null);
  const renditions = useServerInfo(connectionId).data?.renditions;
  const api = useOptionalApi(connectionId);
  if (!api || !connection || !sendToWatchVisible(link, connection.user, renditions)) return null;
  return (book) => {
    void (async () => {
      try {
        const { paired } = await sendBookToWatch(api, connection, libraryId, book);
        toast({
          title: t('library.bookActions.sentToWatch'),
          description: paired ? t('library.bookActions.sentToWatchPair') : book.title,
        });
      } catch (e) {
        toast({ title: watchErrorText(e, connection.name, t) });
      }
    })();
  };
}

/** Send to watch for a book of this connection, null where it isn't offered. Every book row
 * asks, so a platform with no watch link costs nothing: the choice is made once, at load. */
export const useSendToWatch: (connectionId: string, libraryId: number) => SendToWatch | null =
  watchLink.supported ? useSendToWatchLinked : () => null;
