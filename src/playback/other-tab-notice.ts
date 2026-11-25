import { t } from 'i18next';
import { AppState } from 'react-native';

import { toast } from '@/components/ui/toast';
import { isAway } from '@/lib/app-activity';
import { PROGRESS_MIRROR_KEY } from '@/lib/storage-keys';
import { onStoredChange } from '@/lib/tab-channel';
import { onForeground, whenActive } from '@/lib/when-active';

import { onGaveWayToTab, selectIsTransportLive, showOtherTabsPlace, usePlayer } from './store';

/**
 * A web tab explains why it yielded, even if the tab that took over has since closed.
 * While visible, a paused tab follows the other tab's saves. On return it also picks
 * up any changes made while it was hidden.
 */
export function startOtherTabNotice(): () => void {
  let cancel = () => {};
  const stop = onGaveWayToTab((reason) => {
    cancel(); // one notice, however often it gave way while hidden
    // In front now: the pause this notice is about has not reached the store yet.
    const inFront = AppState.currentState === 'active';
    cancel = whenActive(() => {
      if (reason === 'cast-pause-failed') {
        toast({ title: t('player.otherTab.castPauseFailed') });
      } else if (inFront || !selectIsTransportLive(usePlayer.getState())) {
        toast({ title: t('player.otherTab.title') });
      }
    });
  });
  const stopShowing = onForeground(showOtherTabsPlace);
  const stopWatching = onStoredChange(PROGRESS_MIRROR_KEY, () => {
    if (!isAway()) showOtherTabsPlace();
  });
  return () => {
    cancel();
    stop();
    stopShowing();
    stopWatching();
  };
}
