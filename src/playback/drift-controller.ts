import { t } from 'i18next';

import { addBookmark } from '@/api/hooks';
import { toast } from '@/components/ui/toast';
import { formatWallClock } from '@/lib/format';

import { driftOffer, saveDrift, takeDrift, type DriftRecord } from './drift';
import { startInteractionWatch } from './last-interaction';
import { onSleepTimerEnded, type FellAsleep } from './sleep-timer';
import {
  selectBookKey,
  selectBookPosition,
  selectIsPlaying,
  selectIsTransportLive,
  usePlayer,
} from './store';

/**
 * "Fell asleep": what happens after a sleep timer stopped a book nobody was awake for
 * (STYLEGUIDE section 9, "Sleep"). Started once from `src/app/_layout.tsx`, like
 * `startAutoSleep`; returns its teardown. Framework-free: subscriptions, no rendering.
 *
 * 1. **The bookmark.** When the timer reports a drift-off (`FellAsleep`, the one ending
 *    where it fired, paused a playing book and its grace closed with the listener not
 *    stirring), a bookmark named "Fell asleep" goes on the playing book's server at the
 *    position where playback stopped, through that book's own connection
 *    (`resolveClient`). Best effort: offline, signed out or refused, it is simply not
 *    made - it never throws and never waits on anything the pause needs. The note is
 *    translated when it is made, in the listener's language at that moment (it is
 *    stored on the server as text; a later language switch does not rename it).
 * 2. **The record.** The last touch of the player before the timer fired
 *    (`last-interaction`) and the stop position are remembered on the device
 *    (`drift.ts`, per book, 36 h).
 * 3. **The prompt.** The next time that book starts playing, once: "You drifted off
 *    around 23:41. Jump back 4 minutes?" with a Jump back action that seeks to the last
 *    touch (only for a gap of 1-60 content minutes, and only when the book starts near
 *    where it stopped).
 */
export function startDriftWatch(): () => void {
  const stopInteractions = startInteractionWatch();

  const unsubscribeEnded = onSleepTimerEnded((outcome) => {
    if (outcome.fellAsleep) fellAsleep(outcome.bookKey, outcome.fellAsleep);
  });

  // The play edge: playback starting, or a different book playing.
  const unwatchPlayer = usePlayer.subscribe((state, prev) => {
    if (!selectIsPlaying(state)) return;
    const key = selectBookKey(state);
    if (key === null) return;
    if (selectIsPlaying(prev) && selectBookKey(prev) === key) return;
    void offerJumpBack(key);
  });

  return () => {
    stopInteractions();
    unsubscribeEnded();
    unwatchPlayer();
  };
}

function fellAsleep(bookKey: string, fell: FellAsleep) {
  const player = usePlayer.getState();
  const np = player.nowPlaying;
  // The timer only reports a drift-off for the book that is still loaded (a book change
  // ends it as a plain expiry), so this is a guard, not a branch anyone expects to take.
  if (!np || selectBookKey(player) !== bookKey) return;

  makeBookmark(np.connectionId, np.libraryId, np.path, fell.stoppedAt);

  if (!fell.touch) return; // nothing to jump back to
  const record: DriftRecord = {
    touchAt: fell.touch.at,
    touchPosition: fell.touch.position,
    stoppedAt: fell.stoppedAt,
    recordedAt: Date.now(),
  };
  // The listener pressing play the next morning can be the very write that closes the
  // grace (iOS slept through it): the play edge has then already gone by, so offer now.
  if (selectIsTransportLive(player)) prompt(bookKey, record);
  else void saveDrift(bookKey, record);
}

function makeBookmark(connectionId: string, libraryId: number, path: string, position: number) {
  try {
    void addBookmark(
      connectionId,
      libraryId,
      path,
      Math.round(position),
      t('player.sleepTimer.fellAsleepNote'),
    ).catch(() => {
      // gone, offline or refused: there is simply no bookmark this time
    });
  } catch {
    // never let a bookmark take the timer's ending path down with it
  }
}

async function offerJumpBack(bookKey: string) {
  const record = await takeDrift(bookKey, Date.now());
  if (record) prompt(bookKey, record);
}

function prompt(bookKey: string, record: DriftRecord) {
  const player = usePlayer.getState();
  if (selectBookKey(player) !== bookKey) return; // another book by the time storage answered
  const offer = driftOffer(record, Date.now(), selectBookPosition(player));
  if (!offer) return;
  toast({
    title: t('player.drift.title', { time: formatWallClock(new Date(offer.touchAt)) }),
    description: t('player.drift.description', { count: offer.minutes }),
    action: {
      label: t('player.drift.jumpBack'),
      onPress: () => {
        // Only into the book it was offered for.
        if (selectBookKey(usePlayer.getState()) === bookKey) {
          void usePlayer.getState().seekBook(offer.jumpTo);
        }
      },
    },
  });
}
