import { t } from 'i18next';
import { AppState } from 'react-native';

import { toast } from '@/components/ui/toast';
import { onForeground, whenActive } from '@/lib/when-active';

import { onGaveWayToTab, showOtherTabsPlace, usePlayer } from './store';

/**
 * "Playing in another tab": the notice a web tab shows when it paused because another tab
 * of the same connection began playing (`playing-claim.ts`, fe#123). Shown once the tab is
 * looked at (it is usually hidden behind the tab that plays), and not at all when it plays
 * again by then. Started with the root's services; the store only ever gives way on the web.
 *
 * Looked at again, a paused tab also shows where the other tab has played its book to since
 * (`showOtherTabsPlace`), not the place it stopped at.
 */
export function startOtherTabNotice(): () => void {
  let cancel = () => {};
  const stop = onGaveWayToTab(() => {
    cancel(); // one notice, however often it gave way while hidden
    // In front now: the pause this notice is about has not reached the store yet.
    const inFront = AppState.currentState === 'active';
    cancel = whenActive(() => {
      if (!inFront && usePlayer.getState().snapshot.state === 'playing') return;
      toast({ title: t('player.otherTab.title') });
    });
  });
  const stopShowing = onForeground(showOtherTabsPlace);
  return () => {
    cancel();
    stop();
    stopShowing();
  };
}
