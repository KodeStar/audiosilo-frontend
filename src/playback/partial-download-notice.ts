import { t } from 'i18next';

import { toast } from '@/components/ui/toast';
import { whenActive } from '@/lib/when-active';

import { onPartialDownloadEnd } from './store';

/**
 * "The rest of this book isn't downloaded": the player stopped, paused, at the end of a
 * download that lacks the book's last file (offline, D3, fe#185) instead of
 * finishing the book. Shown once the app is looked at (the stop usually happens in the
 * background or in the car). Started with the root's services.
 */
export function startPartialDownloadNotice(): () => void {
  let cancel = () => {};
  const stop = onPartialDownloadEnd(() => {
    cancel(); // one notice, however often it stopped while hidden
    cancel = whenActive(() => toast({ title: t('player.partialDownload.title') }));
  });
  return () => {
    cancel();
    stop();
  };
}
